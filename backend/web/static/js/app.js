/*
 * AI Code Reviewer - Web UI
 *
 * Không dùng framework, không cần build step: mở file này là chạy.
 * CodeMirror nằm sẵn trong /static/vendor nên demo offline vẫn được.
 */
// Lỗi JS lọt lên được hiện ở dải kết quả thay vì chỉ nằm trong console.
window.addEventListener("error", function (e) {
  var box = document.getElementById("meta");
  if (!box) return;
  var detail = (e.error && e.error.stack) ? e.error.stack : (e.message || String(e.error));
  box.textContent = "JS error: " + detail;
});

(function () {
  "use strict";

  // Cho phép trỏ UI sang một backend khác: index.html?api=https://xxx.onrender.com
  var API = (new URLSearchParams(location.search).get("api") || "").replace(/\/$/, "");

  var allIssues = [];
  var activeIndex = -1;
  var markedLines = [];

  var cm = CodeMirror.fromTextArea(document.getElementById("editor"), {
    lineNumbers: true,
    mode: "python",
    indentUnit: 4,
    tabSize: 4,
    theme: "material-darker",
    viewportMargin: Infinity
  });
  cm.setSize("100%", "100%");

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clearHighlights() {
    markedLines.forEach(function (info) {
      cm.removeLineClass(info.line, "background", info.cls);
    });
    markedLines = [];
  }

  function highlightLine(lineNo, cls) {
    var idx = lineNo - 1;
    if (idx < 0 || idx >= cm.lineCount()) return;
    cm.addLineClass(idx, "background", cls);
    markedLines.push({ line: idx, cls: cls });
  }

  function setMeta(text, isError) {
    var box = document.getElementById("meta");
    box.innerHTML = "";
    box.appendChild(el("span", isError ? "err" : "", text));
  }

  // ---------------------------------------------------------------- render

  // Lọc ngay trên mảng đã có sẵn ở client, không gọi lại API.
  function filtered() {
    var t = document.getElementById("fType").value;
    var s = document.getElementById("fSeverity").value;
    var c = document.getElementById("fConfidence").value;
    return allIssues.filter(function (i) {
      return (!t || i.type === t) && (!s || i.severity === s) && (!c || i.confidence === c);
    });
  }

  function emptyState(title, sub) {
    var wrap = el("div", "empty");
    wrap.innerHTML =
      '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z"></path>' +
      '<path d="m9 12 2 2 4-4"></path></svg>';
    wrap.appendChild(el("div", "empty-title", title));
    wrap.appendChild(el("div", "empty-sub", sub));
    return wrap;
  }

  function renderIssues() {
    var box = document.getElementById("issues");
    box.innerHTML = "";
    var list = filtered();

    var countEl = document.getElementById("issueCount");
    if (countEl) {
      countEl.textContent = String(list.length);
      countEl.title = allIssues.length + " lỗi tổng cộng";
    }

    if (!list.length) {
      box.appendChild(emptyState(
        allIssues.length ? "Không có lỗi khớp bộ lọc" : "Không phát hiện lỗi",
        allIssues.length
          ? "Thử bỏ bớt điều kiện lọc để xem toàn bộ kết quả."
          : "Code sạch, hoặc chưa có kết quả phân tích."
      ));
      return;
    }

    list.forEach(function (issue) {
      var index = allIssues.indexOf(issue);
      var card = el("div", "issue " + issue.type);
      card.dataset.index = String(index);

      var head = el("div", "issue-head");
      head.appendChild(el("span", "line", "Dòng " + issue.line));
      head.appendChild(el("span", "tag " + issue.type, issue.type));
      head.appendChild(el("span", "chip sev-" + issue.severity, "sev " + issue.severity));
      head.appendChild(el("span", "chip conf-" + issue.confidence, "conf " + issue.confidence));
      if (issue.cwe_id) head.appendChild(el("span", "chip cwe", issue.cwe_id));
      head.appendChild(el("span", "chip src-" + issue.source, "src " + issue.source));
      card.appendChild(head);

      card.appendChild(el("div", "msg", issue.message || "(không có mô tả)"));
      if (issue.explanation) card.appendChild(el("div", "explanation", issue.explanation));
      if (issue.suggestion) card.appendChild(el("div", "suggestion", issue.suggestion));

      card.addEventListener("click", function () {
        selectIssue(index, true);
      });
      box.appendChild(card);
    });
  }

  // Chọn 1 lỗi: tô sáng thẻ bên phải và (tuỳ chọn) cuộn code sang dòng tương ứng.
  function selectIssue(index, scrollToLine) {
    activeIndex = index;
    clearHighlights();

    Array.prototype.forEach.call(document.querySelectorAll(".issue"), function (card) {
      card.classList.toggle("active", Number(card.dataset.index) === index);
    });

    if (index < 0) return;

    var issue = allIssues[index];
    highlightLine(issue.line, "cm-highlight-line");

    if (scrollToLine) {
      var pos = { line: Math.max(0, issue.line - 1), ch: 0 };
      cm.scrollIntoView(pos, 120);
      cm.setCursor(pos);
      cm.focus();
    }
  }

  // Bấm vào 1 dòng code -> sáng lỗi tương ứng bên phải.
  cm.on("cursorActivity", function () {
    var line = cm.getCursor().line + 1;
    var idx = -1;
    for (var i = 0; i < allIssues.length; i++) {
      if (allIssues[i].line === line) { idx = i; break; }
    }
    if (idx === -1) return;

    selectIssue(idx, false);
    var card = document.querySelector('.issue[data-index="' + idx + '"]');
    if (card) card.scrollIntoView({ block: "nearest" });
  });

  // ------------------------------------------------------------------- api

  function handleResult(data) {
    allIssues = (data && data.issues) || [];
    renderIssues();

    var countEl = document.getElementById("issueCount");
    if (countEl) {
      countEl.textContent = String(allIssues.length);
      countEl.title = allIssues.length + " lỗi tổng cộng";
    }

    var m = (data && data.meta) || {};
    var parts = [
      "Chế độ: " + (m.mode || "?"),
      "Bandit: " + (m.bandit_count || 0),
      "LLM: " + (m.llm_count || 0),
      "Bị lọc do sai số dòng: " + (m.dropped_invalid_lines || 0),
      "Gộp trùng: " + (m.merged_count || 0),
      "Tổng lỗi: " + allIssues.length
    ];
    if (m.llm_error) parts.push("Lỗi LLM: " + m.llm_error);

    setMeta(parts.join("  ·  "), Boolean(m.llm_error) && allIssues.length === 0);
  }

  function post(url, payload) {
    var isMock = url.indexOf("/mock/") !== -1;
    var btn = document.getElementById(isMock ? "btnMock" : "btnRun");
    var other = document.getElementById(isMock ? "btnRun" : "btnMock");
    var label = btn ? btn.querySelector(".btn-label") : null;
    var oldLabel = label ? label.textContent : "";

    if (btn) {
      btn.disabled = true;
      btn.classList.add("loading");
    }
    if (other) other.disabled = true;
    if (label) label.textContent = "Đang xử lý...";

    return fetch(API + url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.detail || ("HTTP " + res.status));
          return body;
        });
      })
      .then(handleResult)
      .catch(function (err) {
        setMeta("Lỗi gọi API: " + err.message, true);
        var countEl = document.getElementById("issueCount");
        if (countEl) countEl.textContent = "0";
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("loading");
        }
        if (other) other.disabled = false;
        if (label) label.textContent = oldLabel;
      });
  }

  // ---------------------------------------------------------------- events

  document.getElementById("btnRun").addEventListener("click", function () {
    post("/review", {
      code: cm.getValue(),
      filename: "snippet.py",
      mode: document.getElementById("fMode").value
    });
  });

  document.getElementById("btnMock").addEventListener("click", function () {
    post("/mock/review", {
      code: cm.getValue(),
      filename: "snippet.py",
      mode: document.getElementById("fMode").value
    });
  });

  document.getElementById("btnSample").addEventListener("click", function () {
    fetch(API + "/sample")
      .then(function (r) { return r.json(); })
      .then(function (d) { cm.setValue(d.code || ""); });
  });

  ["fType", "fSeverity", "fConfidence"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", renderIssues);
  });

  document.getElementById("btnReset").addEventListener("click", function () {
    document.getElementById("fType").value = "";
    document.getElementById("fSeverity").value = "";
    document.getElementById("fConfidence").value = "";
    renderIssues();
  });

  // ------------------------------------------------------------ trạng thái

  fetch(API + "/health")
    .then(function (r) { return r.json(); })
    .then(function (h) {
      var badge = document.getElementById("llmStatus");
      badge.textContent = h.llm_enabled ? "LLM: sẵn sàng" : "LLM: chưa cấu hình (chỉ Bandit)";
      badge.className = "badge " + (h.llm_enabled ? "on" : "off");
    })
    .catch(function () {
      var badge = document.getElementById("llmStatus");
      badge.textContent = "Không kết nối được server";
      badge.className = "badge off";
    });
})();
