/*
 * AI Code Reviewer — Web UI
 * Khớp hợp đồng JSON v2 (backend/app/schemas.py):
 *   POST /review       { code, filename, mode }  -> { issues[], meta{} }
 *   GET  /health                                 -> { status, llm_enabled, max_code_length }
 */
(function () {
  "use strict";

  /* Tự động xác định địa chỉ API backend:
   * 1. Nhận qua query string: index.html?api=http://localhost:8000
   * 2. Nếu mở trực tiếp dạng file:/// -> tự trỏ về http://127.0.0.1:8000
   * 3. Nếu chạy qua web server (http://localhost:8000) -> dùng relative path ""
   */
  var defaultApi = (window.location && (window.location.protocol === "file:" || !window.location.port))
    ? "http://127.0.0.1:8000"
    : "";
  var API = (new URLSearchParams(window.location.search || "").get("api") || defaultApi).replace(/\/$/, "");

  /* ---------------------------------------------------------------- refs */
  var els = {
    meta: document.getElementById("meta"),
    issues: document.getElementById("issues"),
    count: document.getElementById("issueCount"),
    status: document.getElementById("llmStatus"),
    run: document.getElementById("btnRun"),
    upload: document.getElementById("btnUpload"),
    fileInput: document.getElementById("fileInput"),
    reset: document.getElementById("btnReset"),
    history: document.getElementById("btnHistory"),
    historyClear: document.getElementById("btnHistoryClear"),
    historyClose: document.getElementById("btnHistoryClose"),
    historyModal: document.getElementById("historyModal"),
    historyBackdrop: document.getElementById("historyBackdrop"),
    historyList: document.getElementById("historyList"),
    historyEmpty: document.getElementById("historyEmpty"),
    mode: document.getElementById("fMode"),
    type: document.getElementById("fType"),
    severity: document.getElementById("fSeverity"),
    confidence: document.getElementById("fConfidence"),
    counter: document.getElementById("codeCounter"),
    fileName: document.getElementById("fileName")
  };

  /* --------------------------------------------------------------- state */
  var allIssues = [];
  var activeLines = [];   // dòng đang được chọn (màu xanh)
  var issueLines = [];    // tất cả dòng có lỗi (màu đỏ nhạt)
  var hasRun = false;
  var lastMeta = null;
  var maxCodeLength = 0;
  var isBusy = false;
  var syncFromCard = false;
  var appliedFixes = {};  // index issue -> { marker, original, applied } (các sửa đã áp dụng, có thể hoàn tác)
  var SEV_RANK = { high: 3, medium: 2, low: 1 };
  var HISTORY_KEY = "ai-code-reviewer.review-history.v1";
  var HISTORY_LIMIT = 20;
  var historyLastFocus = null;
  var historyStorageError = "";
  var currentFilename = "snippet.py";   // tên file đang mở (hiển thị + đặt tên lịch sử)
  var REQUEST_TIMEOUT_MS = 330000;      // phải lớn hơn LLM_TIMEOUT của backend
  var MAX_UPLOAD_BYTES = 1024 * 1024;   // file > 1 MB bị từ chối, không nạp vào editor
  var ALLOWED_EXT = [".py", ".pyw", ".txt"];

  /* ---------------------------------------------------------- code editor */
  var cm = null;

  function currentThemeAttr() {
    var theme = document.documentElement.getAttribute("data-theme");
    return (theme === "light" || theme === "dark") ? theme : "auto";
  }

  function prefersDark() {
    if (!window.matchMedia) return true;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function currentEditorTheme() {
    var theme = currentThemeAttr();
    if (theme === "light") return "reviewer-light";
    if (theme === "dark") return "reviewer-dark";
    return prefersDark() ? "reviewer-dark" : "reviewer-light";
  }

  function applyEditorTheme() {
    if (cm) cm.setOption("theme", currentEditorTheme());
  }

  var editorTextarea = document.getElementById("editor");
  if (editorTextarea && typeof CodeMirror !== "undefined") {
    try {
      cm = CodeMirror.fromTextArea(editorTextarea, {
        lineNumbers: true,
        mode: "python",
        indentUnit: 4,
        tabSize: 4,
        theme: currentEditorTheme(),
        viewportMargin: Infinity,
        extraKeys: {
          "Ctrl-Enter": function () { runReview(); },
          "Cmd-Enter": function () { runReview(); }
        }
      });
      cm.setSize("100%", "100%");
    } catch (e) {
      console.warn("Không thể khởi tạo CodeMirror:", e);
    }
  }

  if (cm) {
    if (window.matchMedia) {
      var schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
      var onSchemeChange = function () {
        if (currentThemeAttr() === "auto") applyEditorTheme();
      };
      if (schemeQuery.addEventListener) schemeQuery.addEventListener("change", onSchemeChange);
      else if (schemeQuery.addListener) schemeQuery.addListener(onSchemeChange);
    }
    if (typeof MutationObserver !== "undefined") {
      new MutationObserver(applyEditorTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"]
      });
    }
  }

  function getCode() {
    if (cm) return cm.getValue();
    var ta = document.getElementById("editor");
    return ta ? ta.value : "";
  }

  function setCode(val) {
    var text = String(val || "");
    if (cm) {
      cm.setValue(text);
      cm.refresh();
      setTimeout(function () { if (cm) cm.refresh(); }, 50);
      setTimeout(function () { if (cm) cm.refresh(); }, 200);
    }
    var ta = document.getElementById("editor");
    if (ta) {
      ta.value = text;
    }
    updateCounter();
  }

  function fmt(n) { return Number(n || 0).toLocaleString("vi-VN"); }

  function isOverLimit() {
    return !!(maxCodeLength && getCode().length > maxCodeLength);
  }

  /* Nút Phân tích chỉ khóa khi đang chạy hoặc mã quá dài. Nút Lịch sử và bộ lọc luôn dùng được. */
  function syncRunButton() {
    var btn = els.run || document.getElementById("btnRun");
    if (!btn) return;
    var over = isOverLimit();
    btn.disabled = isBusy || over;
    btn.title = over ? "Mã nguồn vượt giới hạn, hãy rút gọn trước khi phân tích" : "Phân tích mã nguồn (Ctrl + Enter)";
  }

  function updateCounter() {
    var c = els.counter || document.getElementById("codeCounter");
    var n = getCode().length;
    var over = !!(maxCodeLength && n > maxCodeLength);
    if (c) {
      c.textContent = fmt(n) + (maxCodeLength ? " / " + fmt(maxCodeLength) : "") + " ký tự" + (over ? " · QUÁ DÀI" : "");
      c.classList.toggle("over", over);
    }
    syncRunButton();
  }

  function setFileLabel(name) {
    var f = els.fileName || document.getElementById("fileName");
    if (f) f.textContent = (name && name !== "snippet.py") ? "· " + name : "";
  }

  if (cm) {
    cm.on("change", function () { updateCounter(); });
  } else if (editorTextarea) {
    editorTextarea.addEventListener("input", function () { updateCounter(); });
  }

  /* ------------------------------------------------------------- helpers */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeSvgIcon(className) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);
    ["M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z", "m9 12 2 2 4-4"].forEach(function (d) {
      var path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    });
    return svg;
  }

  function setMeta(text, level) {
    var metaEl = els.meta || document.getElementById("meta");
    if (!metaEl) return;
    metaEl.textContent = text;
    metaEl.classList.remove("warn", "error");
    if (level) metaEl.classList.add(level);
  }

  function setStatus(state, text) {
    var statusEl = els.status || document.getElementById("llmStatus");
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "badge " + state;
  }

  function setBusy(busy) {
    isBusy = busy;
    syncRunButton();
  }

  function startLoading(btn, label) {
    if (!btn) return function () {};
    var span = btn.querySelector(".btn-label");
    var original = span ? span.textContent : "";
    btn.classList.add("loading");
    if (span) span.textContent = label;
    return function () {
      btn.classList.remove("loading");
      if (span) span.textContent = original;
    };
  }

  /* --------------------------------------------------- line highlighting */

  function clearActiveLines() {
    if (cm) {
      activeLines.forEach(function (idx) {
        try { cm.removeLineClass(idx, "background", "cm-highlight-line"); } catch (_) {}
      });
    }
    activeLines = [];
  }

  function clearIssueLines() {
    if (cm) {
      issueLines.forEach(function (idx) {
        try { cm.removeLineClass(idx, "background", "cm-line-error"); } catch (_) {}
      });
    }
    issueLines = [];
  }

  function markIssueLines(list) {
    if (!cm) return;
    clearIssueLines();
    (list || []).forEach(function (issue) {
      var idx = Number(issue.line) - 1;
      if (idx >= 0 && idx < cm.lineCount() && issueLines.indexOf(idx) === -1) {
        try {
          cm.addLineClass(idx, "background", "cm-line-error");
          issueLines.push(idx);
        } catch (_) {}
      }
    });
  }

  /* -------------------------------------------------------------- filter */

  function filteredIssues() {
    var typeEl = document.getElementById("fType");
    var sevEl = document.getElementById("fSeverity");
    var confEl = document.getElementById("fConfidence");

    var t = typeEl ? typeEl.value.toLowerCase().trim() : "";
    var s = sevEl ? sevEl.value.toLowerCase().trim() : "";
    var c = confEl ? confEl.value.toLowerCase().trim() : "";

    return (allIssues || [])
      .filter(function (issue) {
        if (!issue) return false;
        if (t && String(issue.type || "").toLowerCase().trim() !== t) return false;
        if (s && String(issue.severity || "").toLowerCase().trim() !== s) return false;
        if (c && String(issue.confidence || "").toLowerCase().trim() !== c) return false;
        return true;
      })
      .sort(function (a, b) {
        return (Number(a.line) || 0) - (Number(b.line) || 0) ||
          (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0);
      });
  }

  /* ------------------------------------------- đề xuất & áp dụng bản sửa */

  function clearAppliedFixes() {
    Object.keys(appliedFixes).forEach(function (k) {
      try { appliedFixes[k].marker.clear(); } catch (_) {}
    });
    appliedFixes = {};
  }

  /* Tìm dấu ngoặc đóng khớp với ngoặc mở tại vị trí open (bỏ qua nội dung trong chuỗi) */
  function findCloseParen(s, open) {
    var depth = 0, quote = null;
    for (var i = open; i < s.length; i++) {
      var ch = s.charAt(i);
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function missingImports(code, mods) {
    return mods.filter(function (m) {
      return !new RegExp("^\\s*(import\\s+[^\\n]*\\b" + m + "\\b|from\\s+" + m + "\\s+import)", "m").test(code);
    });
  }

  /* f = open(...) ... f.close()  ->  with open(...) as f:  (thay nhiều dòng một lúc) */
  function withOpenFix(issue, text, code, indent) {
    var ctx = [issue.message, issue.explanation, issue.suggestion].join(" ");
    if (!/\bwith\b|context manager|đóng|close/i.test(ctx)) return null;
    var m = /^(\s*)([A-Za-z_]\w*)\s*=\s*(open\(.*\))\s*$/.exec(text);
    if (!m) return null;

    var name = m[2], baseLen = m[1].length;
    var lines = String(code).split("\n");
    var start = Number(issue.line) - 1;
    if (lines[start] !== text) return null;

    var closeRe = new RegExp("^\\s*" + name + "\\.close\\(\\)\\s*(#.*)?$");
    var useRe = new RegExp("\\b" + name + "\\b");
    var end = start, closeAt = -1, lastUse = -1;
    for (var j = start + 1; j < lines.length; j++) {
      var ln = lines[j];
      if (!ln.trim()) { end = j; continue; }
      var ind = (/^\s*/.exec(ln) || [""])[0].length;
      if (ind < baseLen) break;                       /* ra khỏi khối hiện tại */
      end = j;
      if (ind === baseLen && closeRe.test(ln)) { closeAt = j; break; }
      if (useRe.test(ln)) lastUse = j;
    }

    var bodyEnd = closeAt !== -1 ? closeAt - 1 : lastUse;
    if (bodyEnd < start + 1) return null;
    var body = [];
    for (var k = start + 1; k <= bodyEnd; k++) {
      body.push(lines[k].trim() ? "    " + lines[k] : lines[k]);
    }
    var out = [m[1] + "with " + m[3] + " as " + name + ":"].concat(body).join("\n");
    var span = (closeAt !== -1 ? closeAt : bodyEnd) - start + 1;
    return {
      text: out,
      span: span,
      note: "Chuyển sang with open(...) như gợi ý: gộp " + span + " dòng" +
            (closeAt !== -1 ? ", bỏ " + name + ".close() vì with tự đóng file." : ".")
    };
  }

  /* Rút bản sửa từ chính câu gợi ý (khi không có quy tắc mẫu và backend không trả code sửa) */
  function fixFromSuggestion(suggestion, text, indent) {
    var sug = String(suggestion || "");
    if (!sug) return null;
    var ID = "([A-Za-z_][\\w.]*)";
    var m, to, from;

    /* "Dùng `X` thay vì `Y`" / "use X instead of Y" */
    m = new RegExp("`?" + ID + "(?:\\(\\))?`?\\s*(?:thay vì|thay cho|instead of|rather than)\\s*`?" + ID, "i").exec(sug);
    if (m) { to = m[1]; from = m[2]; }
    /* "Thay `Y` bằng `X`" / "replace Y with X" */
    if (!m) {
      m = new RegExp("(?:thay|replace)\\s*`?" + ID + "(?:\\(\\))?`?\\s*(?:bằng|với|with|by)\\s*`?" + ID, "i").exec(sug);
      if (m) { from = m[1]; to = m[2]; }
    }
    if (m && from !== to && text.indexOf(from) !== -1) {
      var esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var out1 = text.replace(new RegExp("(^|[^\\w.])" + esc + "(?=\\s*\\()"), "$1" + to);
      if (out1 !== text) return { text: out1, note: "Thay " + from + " bằng " + to + " theo gợi ý — hãy kiểm tra lại." };
    }

    /* Gợi ý là cả khối code nhiều dòng */
    var rawLines = sug.replace(/\s+$/, "").split("\n").filter(function (l, i, a) { return l.trim() || i > 0; });
    while (rawLines.length && !rawLines[0].trim()) rawLines.shift();
    if (rawLines.length > 1 && /^\s*(with|for|while|if|try|def|class|[\w.]+\s*(=|\())/.test(rawLines[0]) && !/[`]/.test(sug)) {
      var minInd = Math.min.apply(null, rawLines.filter(function (l) { return l.trim(); }).map(function (l) {
        return (/^\s*/.exec(l) || [""])[0].length;
      }));
      var block = rawLines.map(function (l) { return l.trim() ? indent + l.slice(minInd) : ""; }).join("\n");
      if (block !== text) return { text: block, note: "Lấy từ khối code trong gợi ý — hãy kiểm tra lại trước khi áp dụng." };
    }

    /* Gợi ý có 1 đoạn `code` trọn vẹn (có dấu ( hoặc =) -> dùng làm nguyên dòng */
    var snippets = [];
    sug.replace(/`([^`\n]+)`/g, function (_, c) { snippets.push(c.trim()); return _; });
    if (snippets.length === 1 && /[(=]/.test(snippets[0]) && snippets[0] !== text.trim()) {
      var sn = snippets[0];
      var pre = /^\s*([\w.]+\s*=(?!=)\s*|return\s+)/.exec(text);
      if (pre && !/^([\w.]+\s*=(?!=)|return\b)/.test(sn)) sn = pre[1].replace(/^\s*/, "") + sn;
      return { text: indent + sn, note: "Lấy từ đoạn code trong gợi ý — hãy kiểm tra lại trước khi áp dụng." };
    }
    return null;
  }

  /* Sinh bản sửa cho 1 dòng code. Ưu tiên code sửa do backend trả về (fixed_code / fix / ...),
   * nếu không có thì dùng quy tắc theo mẫu. Trả về { text, note } hoặc null. */
  function proposeFix(issue, text, code) {
    var indent = (/^\s*/.exec(text) || [""])[0];
    var direct = issue.fixed_code || issue.fixed_line || issue.fix || issue.replacement || issue.suggested_code;
    if (typeof direct === "string" && direct.trim()) {
      if (indent && !/^\s/.test(direct)) {
        direct = direct.split("\n").map(function (l) { return l ? indent + l : l; }).join("\n");
      }
      if (direct !== text) return { text: direct, note: "Code sửa do hệ thống review đề xuất." };
    }
    if (/^\s*#/.test(text)) return null;

    var wf = withOpenFix(issue, text, code, indent);
    if (wf) return wf;

    var m, out = null, note = "", mods = [];

    if ((m = /^(\s*)except\s*:(.*)$/.exec(text))) {
      out = m[1] + "except Exception:" + m[2];
      note = "Đổi bare except thành except Exception; nên thu hẹp đúng loại ngoại lệ cần bắt.";
    } else if (/(^|[^\w.])eval\s*\(/.test(text)) {
      out = text.replace(/(^|[^\w.])eval\s*\(/g, "$1ast.literal_eval(");
      mods = ["ast"];
      note = "ast.literal_eval chỉ đánh giá literal (số, chuỗi, list, dict…), không chạy mã tùy ý.";
    } else if ((m = /os\.system\s*\(/.exec(text))) {
      var open = m.index + m[0].length - 1;
      var close = findCloseParen(text, open);
      var arg = close > open ? text.slice(open + 1, close).trim() : "";
      if (arg) {
        out = text.slice(0, m.index) + "subprocess.run(shlex.split(" + arg + "), shell=False, check=True)" + text.slice(close + 1);
        mods = ["subprocess", "shlex"];
        note = "subprocess.run với shell=False; hãy chắc chắn tham số không chứa dữ liệu người dùng chưa kiểm tra.";
      }
    } else if (/shell\s*=\s*True/.test(text)) {
      out = text.replace(/shell\s*=\s*True/, "shell=False");
      note = "Khi shell=False, lệnh phải là list tham số, ví dụ [\"ls\", \"-l\"].";
    } else if ((m = /^(\s*)([A-Za-z_][\w.]*)(\s*=\s*)(["'])[^"']{3,}\4(.*)$/.exec(text)) && /password|passwd|secret|api_key|token/i.test(m[2])) {
      var envName = m[2].split(".").pop().toUpperCase();
      out = m[1] + m[2] + m[3] + 'os.getenv("' + envName + '")' + m[5];
      mods = ["os"];
      note = "Đặt giá trị thật vào biến môi trường " + envName + " thay vì ghi cứng trong code.";
    } else if (/hashlib\.(md5|sha1)\s*\(/.test(text)) {
      out = text.replace(/hashlib\.(md5|sha1)\s*\(/, "hashlib.sha256(");
      note = "SHA-256 cho digest dài hơn (64 ký tự hex); nếu băm mật khẩu nên dùng bcrypt/argon2.";
    }

    if (!out || out === text) {
      var fromSug = fixFromSuggestion(issue.suggestion, text, indent);
      if (fromSug) return fromSug;
      return null;
    }
    var miss = missingImports(code, mods);
    if (miss.length) note += " Cần thêm: import " + miss.join(", ") + " ở đầu file.";
    return { text: out, note: note };
  }

  /* Sau khi số dòng đổi, dời số dòng của các lỗi nằm phía dưới để vẫn trỏ đúng chỗ */
  function shiftIssueLines(exceptIndex, afterLine, delta) {
    if (!delta) return;
    allIssues.forEach(function (it, i) {
      if (i !== exceptIndex && it && Number(it.line) > afterLine) it.line = Number(it.line) + delta;
    });
  }

  function refreshAfterFix(index) {
    var issuesEl = els.issues || document.getElementById("issues");
    var top = issuesEl ? issuesEl.scrollTop : 0;
    updateCounter();
    renderIssues();
    if (issuesEl) issuesEl.scrollTop = top;
    selectIssue(index, false);
  }

  function applyFix(index, newText, note, onUnchanged, span) {
    if (!cm) { setMeta("Editor chưa sẵn sàng.", "error"); return; }
    var issue = allIssues[index];
    if (!issue || appliedFixes[index]) return;

    var idx = Number(issue.line) - 1;
    if (idx < 0 || idx >= cm.lineCount()) {
      setMeta("Dòng " + issue.line + " không tồn tại trong editor.", "error");
      return;
    }
    var last = Math.min(idx + Math.max(1, Number(span) || 1) - 1, cm.lineCount() - 1);
    var origLineCount = last - idx + 1;
    var from = { line: idx, ch: 0 };
    var to = { line: last, ch: cm.getLine(last).length };
    var original = cm.getRange(from, to);
    if (newText === original) {
      setMeta("Nội dung chưa thay đổi so với dòng gốc — hãy sửa ô code trước khi áp dụng.", "warn");
      if (onUnchanged) onUnchanged();
      return;
    }

    /* replaceRange giữ lịch sử undo của CodeMirror nên Ctrl+Z vẫn hoạt động */
    cm.replaceRange(newText, from, to, "+applyFix");

    var parts = newText.split("\n");
    var end = { line: idx + parts.length - 1, ch: parts[parts.length - 1].length };
    var marker = cm.markText(from, end, { className: "cm-fix-applied" });
    appliedFixes[index] = { marker: marker, original: original, applied: newText };

    shiftIssueLines(index, idx + 1, parts.length - origLineCount);
    cm.scrollIntoView({ line: idx, ch: 0 }, 80);

    var hint = /Cần thêm:.*$/.exec(note || "");
    setMeta(
      "Đã áp dụng sửa dòng " + (idx + 1) + ". Bấm ↺ Hoàn tác trên thẻ (hoặc Ctrl+Z) để khôi phục." +
      (hint ? " " + hint[0] : ""),
      hint ? "warn" : ""
    );
    refreshAfterFix(index);
  }

  function undoFix(index) {
    var fx = appliedFixes[index];
    var issue = allIssues[index];
    if (!fx || !issue || !cm) return;

    var range = fx.marker.find();
    if (!range) {
      setMeta("Không tìm thấy vùng code đã sửa (có thể đã bị xóa). Hãy dùng Ctrl+Z để hoàn tác.", "warn");
      return;
    }
    if (cm.getRange(range.from, range.to) !== fx.applied) {
      if (!window.confirm("Đoạn code này đã bị chỉnh tay sau khi áp dụng. Vẫn hoàn tác về dòng gốc (mất các chỉnh sửa đó)?")) return;
    }

    var removedLines = range.to.line - range.from.line;
    cm.replaceRange(fx.original, range.from, range.to, "+undoFix");
    try { fx.marker.clear(); } catch (_) {}
    delete appliedFixes[index];

    var startLine = range.from.line + 1;
    issue.line = startLine;
    shiftIssueLines(index, startLine, (fx.original.split("\n").length - 1) - removedLines);
    cm.scrollIntoView({ line: range.from.line, ch: 0 }, 80);

    setMeta("Đã hoàn tác, dòng " + startLine + " trở về nội dung ban đầu.", "");
    refreshAfterFix(index);
  }

  function buildFixBox(card, issue, index, lineText, applied) {
    var lineNum = Number(issue.line);
    var original = applied ? applied.original : lineText;
    var proposal = applied ? null : proposeFix(issue, original, getCode());
    var baseValue = proposal ? proposal.text : original;
    var spanN = applied ? applied.original.split("\n").length : (proposal && proposal.span) || 1;
    var rangeSuffix = spanN > 1 ? "–" + (lineNum + spanN - 1) : "";

    var wrap = el("div", "fix-wrap");
    wrap.appendChild(el("div", "fix-label", (applied ? "✔ Đã sửa dòng " : "✏ Sửa dòng ") + lineNum + rangeSuffix + ":"));

    var input = document.createElement("textarea");
    input.className = "fix-input";
    input.value = applied ? applied.applied : baseValue;
    input.rows = Math.min(Math.max(input.value.split("\n").length + 1, 2), 6);
    input.spellcheck = false;
    input.disabled = !!applied;
    input.setAttribute("aria-label", "Code thay thế cho dòng " + lineNum);
    wrap.appendChild(input);

    if (proposal && proposal.note) {
      wrap.appendChild(el("div", "fix-note", "💡 " + proposal.note));
    } else if (!applied && !proposal) {
      wrap.appendChild(el("div", "fix-note", "Chưa có đề xuất tự động cho lỗi này — hãy sửa tay ở ô trên rồi bấm Áp dụng."));
    }

    var row = el("div", "fix-row");

    var applyBtn = el("button", "btn-apply", applied ? "✔ Đã áp dụng" : "✔ Áp dụng");
    applyBtn.type = "button";
    applyBtn.disabled = !!applied;
    applyBtn.title = "Thay dòng " + lineNum + " trong editor bằng nội dung ở ô trên";
    applyBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      applyFix(index, input.value, proposal ? proposal.note : "", function () {
        var w = wrap.querySelector(".fix-warn");
        if (!w) { w = el("div", "fix-note fix-warn"); wrap.insertBefore(w, row); }
        w.textContent = "⚠ Ô code đang giống hệt dòng gốc nên chưa có gì để áp dụng. Hãy sửa nội dung trong ô này rồi bấm lại.";
        input.focus();
      }, proposal ? proposal.span : 1);
    });
    row.appendChild(applyBtn);

    var undoBtn = el("button", "btn-reset-fix", applied ? "↺ Hoàn tác" : "↺ Đặt lại");
    undoBtn.type = "button";
    undoBtn.title = applied ? "Khôi phục dòng gốc trong editor" : "Đưa ô sửa về nội dung đề xuất ban đầu";
    undoBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      if (applied) undoFix(index);
      else input.value = baseValue;
    });
    row.appendChild(undoBtn);

    wrap.appendChild(row);
    card.appendChild(wrap);
  }

  /* -------------------------------------------------------------- render */

  function emptyState(title, sub) {
    var wrap = el("div", "empty");
    wrap.appendChild(makeSvgIcon("empty-icon"));
    wrap.appendChild(el("div", "empty-title", title));
    wrap.appendChild(el("div", "empty-sub", sub));
    return wrap;
  }

  function syncFilterState() {
    ["fType", "fSeverity", "fConfidence"].forEach(function (id) {
      var s = document.getElementById(id);
      if (s) s.classList.toggle("is-active", !!s.value);
    });
  }

  function renderIssues() {
    syncFilterState();
    var issuesEl = els.issues || document.getElementById("issues");
    var countEl = els.count || document.getElementById("issueCount");
    if (!issuesEl) return;

    var list = filteredIssues();

    clearActiveLines();
    issuesEl.replaceChildren();
    if (countEl) {
      var totalAll = allIssues ? allIssues.length : 0;
      countEl.textContent = (list.length !== totalAll) ? (list.length + " / " + totalAll) : String(list.length);
      countEl.title = list.length + " / " + (allIssues ? allIssues.length : 0) + " lỗi hiển thị";
    }

    markIssueLines(list);

    if (!list.length) {
      if (allIssues && allIssues.length > 0) {
        issuesEl.appendChild(emptyState(
          "Không có lỗi khớp bộ lọc",
          "Có " + allIssues.length + " lỗi được tìm thấy nhưng không khớp bộ lọc đang chọn. Bấm “Xóa lọc” để hiển thị toàn bộ."
        ));
      } else if (hasRun) {
        if (lastMeta && lastMeta.llm_error) {
          issuesEl.appendChild(emptyState(
            "Không có kết quả LLM",
            "LLM gặp lỗi: " + lastMeta.llm_error
          ));
        } else {
          issuesEl.appendChild(emptyState(
            "Không phát hiện lỗi",
            "Mã nguồn an toàn hoặc không phát hiện vấn đề nào."
          ));
        }
      } else {
        issuesEl.appendChild(emptyState(
          "Chưa có kết quả",
          "Dán code hoặc bấm “Tải file .py” rồi bấm “Phân tích” để bắt đầu."
        ));
      }
      return;
    }

    list.forEach(function (issue) {
      var index = allIssues.indexOf(issue);

      var card = el("div", "issue " + (issue.type || "quality"));
      card.dataset.index = String(index);
      if (appliedFixes[index]) card.classList.add("applied");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label",
        "Lỗi dòng " + issue.line + ": " + (issue.message || issue.type));

      var head = el("div", "issue-head");
      head.appendChild(el("span", "line", "Dòng " + (issue.line || "?")));
      head.appendChild(el("span", "tag " + (issue.type || "quality"), issue.type || "info"));
      head.appendChild(el("span", "chip sev-" + (issue.severity || "low"), "mức " + (issue.severity || "low")));
      if (issue.confidence) {
        head.appendChild(el("span", "chip conf-" + issue.confidence, "tin cậy " + issue.confidence));
      }
      if (issue.source) {
        head.appendChild(el("span", "chip src-" + issue.source, issue.source));
      }
      if (issue.cwe_id) {
        head.appendChild(el("span", "chip cwe", issue.cwe_id));
      }
      card.appendChild(head);

      card.appendChild(el("div", "msg", issue.message || "(không có mô tả)"));
      if (issue.explanation) card.appendChild(el("div", "explanation", issue.explanation));
      if (issue.suggestion) card.appendChild(el("div", "suggestion", issue.suggestion));

      /* Chỉ hiện ô sửa khi issue có suggestion VÀ dòng lỗi hợp lệ trong editor */
      var fixLineIdx = Number(issue.line) - 1;
      var hasValidLine = issue.suggestion && cm && fixLineIdx >= 0 && fixLineIdx < cm.lineCount();
      if (hasValidLine) {
        var currentLineText = cm.getLine(fixLineIdx) || "";
        if (currentLineText.trim() || appliedFixes[index]) {
          buildFixBox(card, issue, index, currentLineText, appliedFixes[index]);
        }
      }

      /* Listener click phải ở CUỐI và kiểm tra target để tránh kích hoạt khi bấm fix-input/applyBtn */
      function activate() { selectIssue(index, true); }
      card.addEventListener("click", function (e) {
        /* Không activate nếu click vào ô sửa hoặc các nút bên trong fix-wrap */
        var t = e.target;
        if (t && (t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.closest(".fix-wrap"))) return;
        activate();
      });
      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });

      issuesEl.appendChild(card);
    });
  }

  /* -------------------------------------------------------------- select */

  function selectIssue(index, scrollToLine) {
    clearActiveLines();
    if (!allIssues || index < 0 || index >= allIssues.length) return;

    var issue = allIssues[index];
    var idx = Number(issue.line) - 1;

    if (cm && idx >= 0 && idx < cm.lineCount()) {
      cm.addLineClass(idx, "background", "cm-highlight-line");
      activeLines.push(idx);

      if (scrollToLine) {
        var pos = { line: idx, ch: 0 };
        cm.scrollIntoView(pos, 120);
        syncFromCard = true;
        try {
          cm.setCursor(pos);
        } finally {
          syncFromCard = false;
        }
      }
    }

    var cards = document.querySelectorAll(".issue");
    Array.prototype.forEach.call(cards, function (card) {
      card.classList.toggle("active", Number(card.dataset.index) === index);
    });

    if (scrollToLine) {
      var activeCard = document.querySelector('.issue[data-index="' + index + '"]');
      if (activeCard) activeCard.scrollIntoView({ block: "nearest" });
    }
  }

  if (cm) {
    cm.on("cursorActivity", function () {
      if (syncFromCard) return;

      var line = cm.getCursor().line + 1;
      var visible = filteredIssues();
      for (var i = 0; i < visible.length; i++) {
        if (visible[i].line === line) {
          var index = allIssues.indexOf(visible[i]);
          selectIssue(index, false);
          var card = document.querySelector('.issue[data-index="' + index + '"]');
          if (card) card.scrollIntoView({ block: "nearest" });
          return;
        }
      }

      clearActiveLines();
      Array.prototype.forEach.call(document.querySelectorAll(".issue.active"), function (card) {
        card.classList.remove("active");
      });
    });
  }

  /* ---------------------------------------------------------------- meta */

  function showMeta(meta, total) {
    lastMeta = meta || {};
    var parts = ["Tìm thấy " + total + " lỗi", "Chế độ: " + (meta.mode || "?")];
    var level = "";
    if (meta.llm_error) {
      parts.push("Lỗi LLM: " + meta.llm_error);
      level = "warn";
    }
    setMeta(parts.join("  ·  "), level);
  }

  /* --------------------------------------------------------------- calls */

  function responseError(body, res) {
    var detail = body && body.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail.map(function (item) {
        return item && item.msg ? item.msg : JSON.stringify(item);
      }).join("; ");
    }
    return "HTTP " + res.status;
  }

  /* Phân tích nhanh tại Client nếu server backend chưa chạy */
  function clientSideFallbackAnalysis(code) {
    var issues = [];
    var lines = String(code || "").split(/\r\n|\r|\n/);

    for (var i = 0; i < lines.length; i++) {
      var lineNum = i + 1;
      var text = lines[i];
      var trimmed = text.trim();

      if (trimmed.startsWith("#")) continue;

      if (/\beval\s*\(/.test(text)) {
        issues.push({
          line: lineNum,
          type: "security",
          severity: "high",
          confidence: "high",
          cwe_id: "CWE-95",
          message: "Sử dụng hàm eval() tiềm ẩn nguy cơ thực thi mã độc tùy ý.",
          explanation: "Hàm eval() thực thi chuỗi đầu vào như mã Python, cho phép kẻ tấn công chèn lệnh nguy hiểm.",
          suggestion: "Dùng ast.literal_eval() hoặc parser an toàn hơn thay vì eval().",
          source: "bandit"
        });
      }

      if (/\bexec\s*\(/.test(text)) {
        issues.push({
          line: lineNum,
          type: "security",
          severity: "high",
          confidence: "high",
          cwe_id: "CWE-95",
          message: "Sử dụng hàm exec() để thực thi mã động.",
          explanation: "Hàm exec() có thể bị lợi dụng để chạy mã độc trong ngữ cảnh quyền của ứng dụng.",
          suggestion: "Tránh dùng exec() động; cấu trúc lại mã thành hàm tường minh.",
          source: "bandit"
        });
      }

      if (/\bos\.system\s*\(/.test(text)) {
        issues.push({
          line: lineNum,
          type: "security",
          severity: "high",
          confidence: "high",
          cwe_id: "CWE-78",
          message: "Gọi lệnh hệ điều hành trực tiếp qua os.system().",
          explanation: "os.system() không lọc đầu vào an toàn, dễ dẫn đến Command Injection.",
          suggestion: "Dùng subprocess.run(..., shell=False) kèm mảng tham số.",
          source: "bandit"
        });
      }

      if (/shell\s*=\s*True/.test(text)) {
        issues.push({
          line: lineNum,
          type: "security",
          severity: "high",
          confidence: "medium",
          cwe_id: "CWE-78",
          message: "subprocess kích hoạt shell=True tiềm ẩn Command Injection.",
          explanation: "Truyền chuỗi lệnh qua shell=True cho phép chèn thêm lệnh con qua dấu chấm phẩy hoặc dấu gạch đứng.",
          suggestion: "Đặt shell=False và truyền tham số dưới dạng danh sách list.",
          source: "bandit"
        });
      }

      if (/(?:password|passwd|secret|api_key|token)\s*=\s*["'][^"']{3,}["']/i.test(text)) {
        issues.push({
          line: lineNum,
          type: "security",
          severity: "medium",
          confidence: "high",
          cwe_id: "CWE-798",
          message: "Thông tin nhạy cảm (mật khẩu/API key) được ghi cứng trong mã nguồn.",
          explanation: "Ghi cứng secret trong code có thể làm rò rỉ credential khi mã được lưu vào VCS.",
          suggestion: "Lấy thông tin nhạy cảm qua biến môi trường os.getenv() hoặc file .env an toàn.",
          source: "bandit"
        });
      }

      if (/^\s*except\s*:/.test(text)) {
        issues.push({
          line: lineNum,
          type: "quality",
          severity: "low",
          confidence: "high",
          cwe_id: null,
          message: "Bắt ngoại lệ rộng bằng bare 'except:'",
          explanation: "Bare except bắt cả KeyboardInterrupt và SystemExit, gây khó khăn cho việc gỡ lỗi.",
          suggestion: "Chỉ định rõ ngoại lệ cần xử lý, ví dụ: except Exception as e:",
          source: "llm"
        });
      }

      if (/hashlib\.(?:md5|sha1)\s*\(/.test(text)) {
        issues.push({
          line: lineNum,
          type: "security",
          severity: "medium",
          confidence: "high",
          cwe_id: "CWE-327",
          message: "Sử dụng thuật toán băm yếu (MD5/SHA1).",
          explanation: "MD5 và SHA1 đã bị bẻ khóa và có lỗ hổng xung đột băm.",
          suggestion: "Chuyển sang thuật toán an toàn hơn như hashlib.sha256() hoặc bcrypt/argon2.",
          source: "bandit"
        });
      }
    }

    return issues;
  }

  function requestReview(url, btn, busyLabel, requireCode) {
    if (isBusy) return;

    var code = getCode();
    if (requireCode && !code.trim()) {
      setMeta("Mã nguồn trống — hãy dán code hoặc tải file .py trước khi phân tích.", "warn");
      return;
    }
    if (requireCode && maxCodeLength && code.length > maxCodeLength) {
      setMeta(
        "Mã nguồn quá dài (" + fmt(code.length) + " > " + fmt(maxCodeLength) +
        " ký tự). Hãy xóa bớt hoặc chia nhỏ rồi phân tích lại.",
        "error"
      );
      return;
    }

    var stopLoading = startLoading(btn, busyLabel);
    setBusy(true);

    var modeEl = document.getElementById("fMode");
    var modeVal = modeEl ? modeEl.value : "hybrid";

    var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timeoutId = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    var startedAt = Date.now();
    var ticker = setInterval(function () {
      setMeta("Đang phân tích… " + Math.round((Date.now() - startedAt) / 1000) +
        " giây (LLM chạy local có thể mất 1–3 phút)", "");
    }, 1000);
    setMeta("Đang phân tích…", "");
    function stopTimers() {
      if (timeoutId) clearTimeout(timeoutId);
      clearInterval(ticker);
    }

    fetch(API + url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code,
        filename: currentFilename,
        mode: modeVal
      }),
      signal: controller ? controller.signal : undefined
    })
      .catch(function (err) {
        err.isTimeout = !!(err && err.name === "AbortError");
        err.isNetwork = !err.isTimeout;
        throw err;
      })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw new Error(responseError(body, res));
          return body;
        });
      })
      .then(function (data) {
        stopTimers();
        var savedToHistory = saveHistory(code, data);
        hasRun = true;
        lastMeta = data.meta || {};
        clearAppliedFixes();
        allIssues = Array.isArray(data.issues) ? data.issues : [];

        clearActiveLines();
        renderIssues();
        var issuesEl = document.getElementById("issues");
        if (issuesEl) issuesEl.scrollTop = 0;
        showMeta(lastMeta, allIssues.length);
        if (!savedToHistory) {
          setMeta("Tìm thấy " + allIssues.length + " lỗi · Không thể lưu lịch sử trên trình duyệt.", "warn");
        }
        var statusEl = document.getElementById("llmStatus");
        if (statusEl && statusEl.classList.contains("error")) checkHealth();
      })
      .catch(function (err) {
        stopTimers();
        if (err.isTimeout) {
          setMeta("Quá thời gian chờ (" + Math.round(REQUEST_TIMEOUT_MS / 1000) +
            " giây). Backend hoặc LLM phản hồi quá chậm; thử rút gọn mã, đổi model hoặc chế độ Chỉ Bandit.", "error");
        } else if (err.isNetwork) {
          // Không kết nối được server (chưa chạy uvicorn): phân tích ngoại tuyến để vẫn có kết quả xem trước
          var fallbackIssues = clientSideFallbackAnalysis(code);
          hasRun = true;
          lastMeta = { mode: "offline-preview", llm_error: "Chưa kết nối backend (" + (API || "cùng host") + ")" };
          clearAppliedFixes();
          allIssues = fallbackIssues;

          clearActiveLines();
          renderIssues();
          showMeta(lastMeta, allIssues.length);
          setMeta("Đã phân tích ngoại tuyến (" + allIssues.length + " lỗi). Server backend chưa chạy: hãy bật uvicorn để có kết quả Bandit + LLM đầy đủ.", "warn");
          setStatus("error", "Chưa kết nối server");
        } else {
          setMeta("Lỗi API: " + err.message, "error");
        }
      })
      .finally(function () {
        setBusy(false);
        stopLoading();
      });
  }

  function runReview() {
    var runBtn = els.run || document.getElementById("btnRun");
    requestReview("/review", runBtn, "Đang phân tích…", true);
  }

  /* ------------------------------------------------------------- upload file */

  function fileExt(name) {
    var m = /\.[^.]+$/.exec(String(name || "").toLowerCase());
    return m ? m[0] : "";
  }

  function resetFindings() {
    clearAppliedFixes();
    allIssues = [];
    hasRun = false;
    lastMeta = null;
    clearActiveLines();
    clearIssueLines();
    ["fType", "fSeverity", "fConfidence"].forEach(function (id) {
      var s = document.getElementById(id);
      if (s) s.value = "";
    });
    renderIssues();
  }

  function handleFile(file, onDone) {
    function done() { if (onDone) onDone(); }
    if (!file) { done(); return; }

    if (isBusy) {
      setMeta("Đang phân tích, hãy đợi xong rồi mới tải file mới.", "warn");
      done();
      return;
    }

    var ext = fileExt(file.name);
    if (ALLOWED_EXT.indexOf(ext) === -1) {
      setMeta("Chỉ hỗ trợ file .py hoặc .txt (file này: " + (ext || "không có đuôi") + ").", "error");
      done();
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setMeta(
        "File quá lớn (" + fmt(file.size) + " byte > " + fmt(MAX_UPLOAD_BYTES) +
        " byte). Không thể nạp lên màn hình; hãy chia nhỏ file.",
        "error"
      );
      done();
      return;
    }

    var reader = new FileReader();
    reader.onload = function (e) {
      var content = String((e.target && e.target.result) || "");
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);   // bỏ BOM

      if (content.indexOf("\u0000") !== -1) {
        setMeta("File không phải văn bản thuần (chứa ký tự nhị phân).", "error");
        done();
        return;
      }
      if (!content.trim()) {
        setMeta("File rỗng: " + file.name, "error");
        done();
        return;
      }

      // Nạp lên editor, xóa kết quả cũ, đặt lại bộ lọc
      setCode(content);
      currentFilename = file.name;
      setFileLabel(file.name);
      resetFindings();

      // Quá dài: vẫn hiện lên màn hình để người dùng cắt bớt, nhưng báo lỗi rõ và không tự phân tích
      if (maxCodeLength && content.length > maxCodeLength) {
        setMeta(
          "Đã nạp " + file.name + " nhưng QUÁ DÀI: " + fmt(content.length) + " > " + fmt(maxCodeLength) +
          " ký tự (giới hạn của hệ thống). Hãy xóa bớt hoặc tách file rồi bấm Phân tích.",
          "error"
        );
        done();
        return;
      }

      setMeta("Đã nạp file: " + file.name + " (" + fmt(file.size) + " byte). Đang tự động phân tích…", "");
      setTimeout(runReview, 100);
      done();
    };

    reader.onerror = function () {
      var msg = reader.error ? reader.error.message : "Lỗi không xác định";
      setMeta("Không thể đọc file: " + msg, "error");
      done();
    };

    reader.readAsText(file, "UTF-8");
  }

  window.__handleFileInput = function (input) {
    if (!input || !input.files || !input.files.length) return;
    var file = input.files[0];
    handleFile(file, function () {
      try { input.value = ""; } catch (_) {}
    });
  };

  /* Hỗ trợ kéo & thả file vào vùng editor */
  var editorWrap = document.querySelector(".editor-wrap");
  if (editorWrap) {
    ["dragenter", "dragover"].forEach(function (eventName) {
      editorWrap.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        editorWrap.style.outline = "2px dashed var(--accent)";
      });
    });
    ["dragleave", "drop"].forEach(function (eventName) {
      editorWrap.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        editorWrap.style.outline = "";
      });
    });
    editorWrap.addEventListener("drop", function (e) {
      var dt = e.dataTransfer;
      var file = dt && dt.files && dt.files[0];
      if (file) {
        handleFile(file);
      }
    });
  }

  /* --------------------------------------------------------------- events */

  var runBtn = els.run || document.getElementById("btnRun");
  if (runBtn) runBtn.addEventListener("click", runReview);

  function resetFilters() {
    ["fType", "fSeverity", "fConfidence"].forEach(function (id) {
      var s = document.getElementById(id);
      if (s) s.value = "";
    });
    renderIssues();
  }

  ["fType", "fSeverity", "fConfidence"].forEach(function (id) {
    var s = document.getElementById(id);
    if (!s) return;
    s.addEventListener("change", renderIssues);
    s.addEventListener("input", renderIssues);
  });
  if (els.reset) els.reset.addEventListener("click", resetFilters);

  if (els.upload && els.fileInput) {
    els.upload.addEventListener("click", function () { els.fileInput.click(); });
    els.fileInput.addEventListener("change", function () { window.__handleFileInput(els.fileInput); });
  }

  if (els.history) els.history.addEventListener("click", function () { openHistoryModal(); });
  if (els.historyClose) els.historyClose.addEventListener("click", function () { closeHistoryModal(); });
  if (els.historyClear) els.historyClear.addEventListener("click", function () { clearHistory(); });
  if (els.historyBackdrop) els.historyBackdrop.addEventListener("click", function () { closeHistoryModal(); });

  window.__renderIssues = renderIssues;
  window.__resetFilters = resetFilters;

  /* --------------------------------------------- copy code */

  function fallbackCopy(text, onDone) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setMeta("Đã sao chép " + text.length.toLocaleString("vi-VN") + " ký tự vào clipboard.", "");
      if (onDone) onDone();
    } catch (e) {
      setMeta("Không thể sao chép: " + e.message, "error");
    }
  }

  function doCopyCode() {
    var code = getCode();
    if (!code.trim()) {
      setMeta("Editor đang trống — không có gì để sao chép.", "warn");
      return;
    }
    var btn = document.getElementById("btnCopy");

    function onCopied() {
      if (btn) btn.classList.add("copied");
      setMeta("Đã sao chép " + code.length.toLocaleString("vi-VN") + " ký tự vào clipboard.", "");
      setTimeout(function () {
        if (btn) btn.classList.remove("copied");
      }, 1500);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(onCopied).catch(function () {
        fallbackCopy(code, onCopied);
      });
    } else {
      fallbackCopy(code, onCopied);
    }
  }

  var copyBtn = document.getElementById("btnCopy");
  if (copyBtn) copyBtn.addEventListener("click", doCopyCode);
  window.__copyCode = doCopyCode;

  /* ------------------------------------------- download code */
  function doDownloadCode() {
    var code = getCode();
    if (!code.trim()) {
      setMeta("Editor đang trống — không có gì để tải xuống.", "warn");
      return;
    }
    try {
      var blob = new Blob([code], { type: "text/x-python;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = (currentFilename && currentFilename !== "snippet.py") ? currentFilename : "code.py";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
      setMeta("Đang tải xuống: " + ((currentFilename && currentFilename !== "snippet.py") ? currentFilename : "code.py") + " (" + code.length.toLocaleString("vi-VN") + " ký tự).", "");
    } catch (e) {
      setMeta("Không thể tải xuống: " + e.message, "error");
    }
  }

  var dlBtn = document.getElementById("btnDownload");
  if (dlBtn) dlBtn.addEventListener("click", doDownloadCode);
  window.__downloadCode = doDownloadCode;

  /* ----------------------------------------------------- local history */

  function isHistoryEntry(entry) {
    return entry && typeof entry.id === "string" && typeof entry.code === "string";
  }

  function readHistory() {
    historyStorageError = "";
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      var entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return [];
      return entries.filter(isHistoryEntry).slice(0, HISTORY_LIMIT);
    } catch (err) {
      historyStorageError = "Không thể đọc dữ liệu từ Local Storage.";
      return [];
    }
  }

  function writeHistory(entries) {
    var list = (entries || []).slice(0, HISTORY_LIMIT);
    // Hết dung lượng Local Storage: bỏ dần bản ghi cũ nhất rồi thử lại
    while (list.length) {
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
        historyStorageError = "";
        return true;
      } catch (err) {
        if (list.length === 1) break;
        list.pop();
      }
    }
    historyStorageError = "Không thể lưu vào Local Storage (đầy dung lượng hoặc trình duyệt chặn).";
    return false;
  }

  function historyTitle(code) {
    var lines = String(code || "").split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim().replace(/\s+/g, " ");
      if (line) return line.length > 58 ? line.slice(0, 57) + "…" : line;
    }
    return "Đoạn mã Python";
  }

  function getEntryTitle(entry) {
    if (entry && typeof entry.title === "string" && entry.title.trim()) {
      return entry.title.trim();
    }
    return historyTitle(entry ? entry.code : "");
  }

  function saveHistory(code, data) {
    try {
      var entries = readHistory();
      if (!Array.isArray(entries)) entries = [];
      var defaultTitle = historyTitle(code);
      entries.unshift({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        title: (currentFilename && currentFilename !== "snippet.py") ? currentFilename : defaultTitle,
        filename: currentFilename,
        createdAt: new Date().toISOString(),
        code: String(code || ""),
        issues: Array.isArray(data && data.issues) ? data.issues : [],
        meta: (data && data.meta && typeof data.meta === "object") ? data.meta : { mode: "?" }
      });
      return writeHistory(entries);
    } catch (e) {
      console.warn("Lỗi lưu lịch sử:", e);
      return false;
    }
  }

  function setHistoryEmpty(title, sub) {
    var emptyEl = els.historyEmpty || document.getElementById("historyEmpty");
    if (!emptyEl) return;
    emptyEl.style.display = "flex";
    var titleEl = emptyEl.querySelector(".empty-title");
    var subEl = emptyEl.querySelector(".empty-sub");
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = sub;
  }

  function formatHistoryTime(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Vừa xong";
    try {
      return date.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
    } catch (err) {
      return date.toLocaleString("vi-VN");
    }
  }

  function renderHistory() {
    var listEl = els.historyList || document.getElementById("historyList");
    var emptyEl = els.historyEmpty || document.getElementById("historyEmpty");
    if (!listEl) return;
    listEl.replaceChildren();

    var entries = [];
    try {
      entries = readHistory() || [];
    } catch (_) {
      entries = [];
    }

    if (!entries.length) {
      if (historyStorageError) {
        setHistoryEmpty("Không đọc được lịch sử", historyStorageError + " Hãy kiểm tra cài đặt chặn dữ liệu trang web của trình duyệt.");
      } else {
        setHistoryEmpty("Chưa có lịch sử", "Kết quả review sẽ được lưu tự động trên trình duyệt này (cùng địa chỉ trang, ví dụ localhost và 127.0.0.1 là hai nơi lưu khác nhau).");
      }
      return;
    }

    if (emptyEl) emptyEl.style.display = "none";
    entries.forEach(function (entry) {
      if (!entry) return;
      var item = el("article", "history-item");
      var copy = el("div", "history-item-copy");
      copy.appendChild(el("div", "history-item-title", getEntryTitle(entry)));

      var issueCount = (Array.isArray(entry.issues) ? entry.issues.length : 0);
      var modeName = (entry.meta && entry.meta.mode) ? entry.meta.mode : "unknown";
      copy.appendChild(el(
        "div",
        "history-item-meta",
        formatHistoryTime(entry.createdAt) + " · " + issueCount + " lỗi · Chế độ: " + modeName
      ));
      item.appendChild(copy);

      var actions = el("div", "history-item-actions");

      var restore = el("button", "btn", "Mở");
      restore.type = "button";
      restore.title = "Nạp lại đoạn mã và kết quả review này";
      restore.addEventListener("click", function () { restoreHistory(entry); });
      actions.appendChild(restore);

      var rename = el("button", "btn ghost", "Đổi tên");
      rename.type = "button";
      rename.title = "Đổi tên bản ghi này";
      rename.addEventListener("click", function () { renameHistory(entry.id); });
      actions.appendChild(rename);

      var remove = el("button", "btn ghost danger", "Xóa");
      remove.type = "button";
      remove.title = "Xóa bản ghi này";
      remove.addEventListener("click", function () { removeHistory(entry.id); });
      actions.appendChild(remove);

      item.appendChild(actions);
      listEl.appendChild(item);
    });
  }

  function renameHistory(id) {
    var entries = readHistory();
    if (!entries) return;
    var target = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) {
        target = entries[i];
        break;
      }
    }
    if (!target) return;

    var curTitle = getEntryTitle(target);
    var newTitle = window.prompt("Nhập tên mới cho bản ghi lịch sử này:", curTitle);
    if (newTitle === null) return; // Người dùng ấn Hủy (Cancel)
    newTitle = newTitle.trim();
    if (!newTitle) {
      window.alert("Tên không được để trống!");
      return;
    }

    target.title = newTitle;
    if (writeHistory(entries)) {
      renderHistory();
    } else {
      setHistoryEmpty("Không thể cập nhật lịch sử", historyStorageError);
    }
  }

  function restoreHistory(entry) {
    if (!entry) return;
    setCode(entry.code || "");
    currentFilename = (typeof entry.filename === "string" && entry.filename) ? entry.filename : "snippet.py";
    setFileLabel(currentFilename);
    var modeEl = document.getElementById("fMode");
    if (modeEl && entry.meta && ["bandit", "llm", "hybrid"].indexOf(entry.meta.mode) !== -1) {
      modeEl.value = entry.meta.mode;
    }
    clearAppliedFixes();
    allIssues = Array.isArray(entry.issues) ? entry.issues : [];
    lastMeta = entry.meta || {};
    hasRun = true;
    clearActiveLines();
    renderIssues();
    var issuesEl = els.issues || document.getElementById("issues");
    if (issuesEl) issuesEl.scrollTop = 0;
    setMeta("Đã khôi phục " + allIssues.length + " lỗi (" + getEntryTitle(entry) + ") · " + formatHistoryTime(entry.createdAt));
    closeHistoryModal();
  }

  function removeHistory(id) {
    if (!window.confirm("Bạn có chắc chắn muốn xóa bản ghi này khỏi lịch sử không?")) {
      return;
    }
    var entries = readHistory();
    if (!entries) return;
    if (writeHistory(entries.filter(function (entry) { return entry.id !== id; }))) {
      renderHistory();
    } else {
      setHistoryEmpty("Không thể cập nhật lịch sử", historyStorageError);
    }
  }

  function clearHistory() {
    if (!window.confirm("Bạn có chắc chắn muốn xóa TOÀN BỘ lịch sử review trên trình duyệt này không?")) {
      return;
    }
    try {
      window.localStorage.removeItem(HISTORY_KEY);
      historyStorageError = "";
      renderHistory();
    } catch (err) {
      historyStorageError = "Không thể xóa Local Storage.";
      setHistoryEmpty("Không thể cập nhật lịch sử", historyStorageError);
    }
  }

  function openHistoryModal() {
    var modal = els.historyModal || document.getElementById("historyModal");
    if (!modal) return;
    historyLastFocus = document.activeElement;
    modal.classList.add("active");
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    try {
      renderHistory();
    } catch (err) {
      console.error("Lỗi khi hiển thị lịch sử:", err);
      setHistoryEmpty("Lỗi hiển thị", err.message);
    }
    var closeBtn = els.historyClose || document.getElementById("btnHistoryClose");
    if (closeBtn) setTimeout(function () { closeBtn.focus(); }, 0);
  }

  function closeHistoryModal() {
    var modal = els.historyModal || document.getElementById("historyModal");
    if (!modal) return;
    modal.classList.remove("active");
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    if (historyLastFocus && typeof historyLastFocus.focus === "function") {
      try { historyLastFocus.focus(); } catch (_) {}
    }
    historyLastFocus = null;
  }

  /* Xuất các hàm ra window để gọi trực tiếp từ HTML onclick / onchange */
  window.__openHistoryModal = openHistoryModal;
  window.__closeHistoryModal = closeHistoryModal;
  window.__clearHistory = clearHistory;

  document.addEventListener("keydown", function (e) {
    var modal = els.historyModal || document.getElementById("historyModal");
    if (e.key === "Escape" && modal && (modal.classList.contains("active") || modal.style.display === "flex")) {
      closeHistoryModal();
    }
  });

  /* ------------------------------------------------------- trạng thái LLM */

  function checkHealth() {
    fetch(API + "/health")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (health) {
        maxCodeLength = Number(health && health.max_code_length) || 0;
        updateCounter();
        if (health && health.llm_enabled) {
          setStatus("on", "LLM: sẵn sàng");
        } else {
          setStatus("off", "LLM: chưa cấu hình (chỉ Bandit)");
        }
      })
      .catch(function () {
        setStatus("error", "Chưa kết nối server");
      });
  }

  try {
    checkHealth();
  } catch (err) {
    console.warn("checkHealth failed:", err);
  }
})();