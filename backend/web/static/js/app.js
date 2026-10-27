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
   * 3. Nếu chạy qua web server (localhost, Render, Railway...) -> dùng relative path ""
   */
  var defaultApi = (window.location && window.location.protocol === "file:")
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
    if (cm) cm.setOption("readOnly", busy);
    if (editorTextarea) editorTextarea.readOnly = busy;
    if (els.upload) els.upload.disabled = busy;
    if (els.fileInput) els.fileInput.disabled = busy;
    if (els.mode) els.mode.disabled = busy;
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
      var start = Number(issue.line) - 1;
      var end = (Number(issue.end_line) || Number(issue.line)) - 1;
      for (var idx = Math.max(0, start); idx <= Math.min(end, cm.lineCount() - 1); idx++) {
        if (issueLines.indexOf(idx) !== -1) continue;
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

  /* Normalize indentation for an exact code replacement from the API. */
  function codeReplacementFromSuggestion(suggestion, indent) {
    var raw = String(suggestion || "").replace(/\s+$/, "");
    if (!raw) return null;
    var lines = raw.split("\n");
    var first = lines[0].trim();
    var looksLikeCode = /^(?:(?:async\s+)?(?:def|class)\b|(?:async\s+)?for\s+.+\s+in\s+.+:|(?:if|elif|while|with)\s+.+:|(?:try|else|finally)\s*:|(?:except\b|return\b|yield\b|raise\b|pass\b|break\b|continue\b|import\b|from\b)|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]\n]+\])*\s*(?:=|[-+*/%]=)\s*|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*\()/.test(first);
    if (!looksLikeCode) return null;

    var minIndent = Math.min.apply(null, lines.filter(function (line) { return line.trim(); }).map(function (line) {
      return (/^\s*/.exec(line) || [""])[0].length;
    }));
    var replacement = lines.map(function (line) {
      return line.trim() ? indent + line.slice(minIndent) : "";
    }).join("\n");
    return replacement;
  }

  /* Use only the backend's exact replacement patch. Never synthesize code from prose. */
  function proposeFix(issue, original) {
    var line = Number(issue.line);
    var endLine = Number(issue.end_line) || line;
    if (!Number.isInteger(line) || !Number.isInteger(endLine) || line < 1 || endLine < line) return null;

    var firstLine = original.split("\n")[0] || "";
    var indent = (/^\s*/.exec(firstLine) || [""])[0];
    var replacement = codeReplacementFromSuggestion(issue.suggestion, indent);
    if (!replacement || replacement === original) return null;
    return {
      text: replacement,
      note: "Bản vá thay thế đúng phạm vi dòng " + line + "–" + endLine + " do API chỉ định."
    };
  }

  /* Keep issue ranges aligned after a source range has been replaced. */
  function shiftIssueLines(exceptIndex, startLine, endLine, delta) {
    if (!delta) return;
    function remap(line) {
      if (line <= startLine) return line;
      if (line > endLine) return line + delta;
      return startLine;
    }
    allIssues.forEach(function (it, i) {
      if (i === exceptIndex || !it) return;
      var oldStart = Number(it.line);
      var oldEnd = Number(it.end_line) || oldStart;
      if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd)) return;
      it.line = remap(oldStart);
      it.end_line = Math.max(it.line, remap(oldEnd));
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

  function reconcileAppliedFix(index) {
    var fx = appliedFixes[index];
    if (!fx || !cm) return fx || null;
    var range = fx.marker && fx.marker.find();
    var issue = allIssues[index];
    var startLine = range ? range.from.line + 1 : Number(issue && issue.line);
    if (!Number.isInteger(startLine) || startLine < 1) return fx;
    var currentEndLine = range ? range.to.line + 1 : (Number(issue && issue.end_line) || startLine);
    var currentText;
    if (range) {
      currentText = cm.getRange(range.from, range.to);
    } else {
      var originalLastLine = startLine + fx.originalLineCount - 2;
      if (originalLastLine >= cm.lineCount()) return fx;
      currentText = cm.getRange(
        { line: startLine - 1, ch: 0 },
        { line: originalLastLine, ch: cm.getLine(originalLastLine).length }
      );
    }
    if (currentText !== fx.original) return fx;

    /* Ctrl+Z or an external editor change already restored the original text. */
    var currentLineCount = currentEndLine - startLine + 1;
    if (issue) {
      issue.line = startLine;
      issue.end_line = startLine + fx.originalLineCount - 1;
      shiftIssueLines(index, startLine, currentEndLine, fx.originalLineCount - currentLineCount);
    }
    try { fx.marker.clear(); } catch (_) {}
    delete appliedFixes[index];
    return null;
  }

  function applyFix(index, newText, note, onUnchanged) {
    if (!cm) { setMeta("Editor chưa sẵn sàng.", "error"); return; }
    var issue = allIssues[index];
    if (!issue || appliedFixes[index]) return;

    var idx = Number(issue.line) - 1;
    var startLine = idx + 1;
    var sourceEndLine = Number(issue.end_line) || startLine;
    if (!String(newText || "").trim()) {
      setMeta("Bản vá đang để trống nên chưa thể áp dụng.", "warn");
      if (onUnchanged) onUnchanged();
      return;
    }
    if (idx < 0 || idx >= cm.lineCount() || sourceEndLine < startLine || sourceEndLine > cm.lineCount()) {
      setMeta("Khoảng dòng của lỗi không còn hợp lệ trong editor.", "error");
      return;
    }
    var last = sourceEndLine - 1;
    var origLineCount = last - idx + 1;
    var from = { line: idx, ch: 0 };
    var to = { line: last, ch: cm.getLine(last).length };
    var original = cm.getRange(from, to);
    if (newText === original) {
      setMeta("Nội dung chưa thay đổi so với mã gốc.", "warn");
      if (onUnchanged) onUnchanged();
      return;
    }

    cm.replaceRange(newText, from, to, "+applyFix");
    var parts = newText.split("\n");
    var newEndLine = startLine + parts.length - 1;
    var end = { line: idx + parts.length - 1, ch: parts[parts.length - 1].length };
    if (cm.getRange(from, end) !== newText) {
      setMeta("Editor không nhận đủ nội dung bản vá; chưa đánh dấu là đã áp dụng.", "error");
      return;
    }
    var marker = cm.markText(from, end, { className: "cm-fix-applied" });
    appliedFixes[index] = {
      marker: marker,
      original: original,
      applied: newText,
      originalLineCount: origLineCount
    };
    issue.end_line = newEndLine;

    shiftIssueLines(index, startLine, sourceEndLine, parts.length - origLineCount);
    cm.scrollIntoView({ line: idx, ch: 0 }, 80);

    setMeta("Đã áp dụng bản vá trong dòng " + startLine + "–" + newEndLine + ". Có thể hoàn tác bằng nút trên thẻ hoặc Ctrl+Z.", "");
    refreshAfterFix(index);
  }
  function undoFix(index) {
    var fx = appliedFixes[index];
    var issue = allIssues[index];
    if (!fx || !issue || !cm) return;

    var range = fx.marker.find();
    if (!range) {
      setMeta("Không tìm thấy vùng mã đã sửa. Hãy dùng Ctrl+Z để hoàn tác.", "warn");
      return;
    }
    if (cm.getRange(range.from, range.to) !== fx.applied) {
      if (!window.confirm("Đoạn mã đã bị chỉnh tay sau khi áp dụng. Vẫn hoàn tác về mã gốc?")) return;
    }

    var startLine = range.from.line + 1;
    var currentEndLine = range.to.line + 1;
    var removedLines = range.to.line - range.from.line;
    cm.replaceRange(fx.original, range.from, range.to, "+undoFix");
    try { fx.marker.clear(); } catch (_) {}
    delete appliedFixes[index];

    issue.line = startLine;
    issue.end_line = startLine + fx.originalLineCount - 1;
    shiftIssueLines(index, startLine, currentEndLine, (fx.original.split("\n").length - 1) - removedLines);
    cm.scrollIntoView({ line: range.from.line, ch: 0 }, 80);

    setMeta("Đã hoàn tác bản vá; mã gốc được khôi phục.", "");
    refreshAfterFix(index);
  }
  function buildFixBox(card, issue, index, applied, proposal) {
    var lineNum = Number(issue.line);
    var issueEndLine = Number(issue.end_line) || lineNum;
    var spanN = Math.max(1, issueEndLine - lineNum + 1);
    var sourceLines = getCode().split(/\r\n|\r|\n/);
    var original = applied ? applied.original : sourceLines.slice(lineNum - 1, issueEndLine).join("\n");
    proposal = applied ? null : proposal;
    var baseValue = proposal ? proposal.text : original;
    var rangeSuffix = spanN > 1 ? "–" + issueEndLine : "";

    var wrap = el("div", "fix-wrap");
    wrap.appendChild(el("div", "fix-label", "Suggestion · mã thay thế cho dòng " + lineNum + rangeSuffix));
    var input = document.createElement("textarea");
    input.className = "fix-input";
    input.value = applied ? applied.applied : baseValue;
    /* Show the complete API patch without clipping long replacements to a fixed row count. */
    input.rows = Math.max(input.value.split("\n").length + 1, 2);
    input.spellcheck = false;
    input.disabled = !!applied;
    input.setAttribute("aria-label", "Mã thay thế cho dòng " + lineNum + rangeSuffix);
    wrap.appendChild(input);

    if (proposal && proposal.note) {
      wrap.appendChild(el("div", "fix-note", proposal.note));
    } else if (!applied) {
      wrap.appendChild(el("div", "fix-note fix-warn", "Không có bản vá dạng mã hợp lệ. Xem phần giải thích; không thể áp dụng lời khuyên dạng văn bản."));
    }

    var row = el("div", "fix-row");
    var applyBtn = el("button", "btn-apply", applied ? "✓ Đã áp dụng" : "✓ Áp dụng");
    applyBtn.type = "button";
    applyBtn.disabled = !!applied;
    applyBtn.title = "Thay dòng " + lineNum + rangeSuffix + " bằng nội dung trong ô mã";
    applyBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      applyFix(index, input.value, proposal ? proposal.note : "", function () {
        input.focus();
      });
    });
    row.appendChild(applyBtn);

    var undoBtn = el("button", "btn-reset-fix", applied ? "↶ Hoàn tác" : "Đặt lại");
    undoBtn.type = "button";
    undoBtn.title = applied ? "Khôi phục mã gốc trong editor" : "Đưa ô mã về bản vá ban đầu";
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
      var appliedState = reconcileAppliedFix(index);

      var card = el("div", "issue " + (issue.type || "quality"));
      card.dataset.index = String(index);
      if (appliedState) card.classList.add("applied");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label",
        "Lỗi dòng " + issue.line + ": " + (issue.message || issue.type));

      var head = el("div", "issue-head");
      var issueEnd = Number(issue.end_line) || Number(issue.line);
      var issueRangeLabel = issueEnd > Number(issue.line) ? issue.line + "–" + issueEnd : (issue.line || "?");
      head.appendChild(el("span", "line", "Dòng " + issueRangeLabel));
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

      var lineNum = Number(issue.line);
      var endLine = Number(issue.end_line) || lineNum;
      var rangeValid = cm && Number.isInteger(lineNum) && Number.isInteger(endLine) &&
        lineNum >= 1 && endLine >= lineNum && endLine <= cm.lineCount();
      var originalRange = rangeValid
        ? cm.getRange({ line: lineNum - 1, ch: 0 }, { line: endLine - 1, ch: cm.getLine(endLine - 1).length })
        : "";
      var isApplied = !!appliedState;
      var shownOriginal = isApplied ? appliedState.original : originalRange;
      var replacement = rangeValid && !isApplied ? codeReplacementFromSuggestion(issue.suggestion, (/^\s*/.exec(originalRange.split("\n")[0] || "") || [""])[0]) : null;
      var proposal = rangeValid && !isApplied ? proposeFix(issue, originalRange) : null;

      if (rangeValid) {
        var sourceRangeLabel = endLine > lineNum ? lineNum + "–" + endLine : String(lineNum);
        card.appendChild(el("div", "issue-code-label", "Code đang bị lỗi · dòng " + sourceRangeLabel));
        card.appendChild(el("pre", "issue-source-code", shownOriginal));
      }
      if (issue.explanation) card.appendChild(el("div", "explanation", issue.explanation));

      if (isApplied) {
        card.appendChild(el("div", "fix-note", "Bản vá đã được áp dụng trong editor."));
      } else if (proposal) {
        /* Bản vá được hiển thị một lần trong ô chỉnh sửa bên dưới. */
      } else if (issue.suggestion && !replacement) {
        card.appendChild(el("div", "suggestion", "Hướng khắc phục: " + issue.suggestion));
      } else if (!issue.suggestion) {
        var noPatchReason = issue.cwe_id === "CWE-369"
          ? "Chưa có bản vá tự động: cần xác định kết quả mong muốn khi đầu vào rỗng trước khi chọn giá trị thay thế cho mẫu số."
          : "Chưa có suggestion dạng bản vá an toàn để áp dụng. Hãy xem giải thích phía trên.";
        card.appendChild(el("div", "fix-note", noPatchReason));
      } else {
        card.appendChild(el("div", "fix-note fix-warn", "Bản vá không thay đổi mã hiện tại nên không thể áp dụng."));
      }

      /* Only an exact code patch (or an already applied patch) gets an apply box. */
      if ((proposal || appliedState) && rangeValid) {
        buildFixBox(card, issue, index, appliedState, proposal);
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

    var endIdx = (Number(issue.end_line) || Number(issue.line)) - 1;
    if (cm && idx >= 0 && idx < cm.lineCount()) {
      for (var lineIdx = idx; lineIdx <= Math.min(endIdx, cm.lineCount() - 1); lineIdx++) {
        cm.addLineClass(lineIdx, "background", "cm-highlight-line");
        activeLines.push(lineIdx);
      }

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
        var issueStart = Number(visible[i].line);
        var issueEnd = Number(visible[i].end_line) || issueStart;
        if (line >= issueStart && line <= issueEnd) {
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
    if (modeEl && entry.meta && ["bandit", "tools", "llm", "filter", "hybrid"].indexOf(entry.meta.mode) !== -1) {
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
