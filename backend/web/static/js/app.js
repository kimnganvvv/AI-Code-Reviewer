/*
 * AI Code Reviewer — Web UI
 * Khớp hợp đồng JSON v2 (backend/app/schemas.py):
 *   POST /review       { code, filename, mode }  -> { issues[], meta{} }
 *   POST /mock/review  { code, filename, mode }  -> { issues[], meta{mode:"mock"} }
 *   GET  /sample                                 -> { code }
 *   GET  /health                                 -> { status, llm_enabled, max_code_length }
 */
(function () {
  "use strict";

  /* Cho phép trỏ UI sang backend khác: index.html?api=https://xxx.onrender.com */
  var API = (new URLSearchParams(location.search).get("api") || "").replace(/\/$/, "");

  /* ---------------------------------------------------------------- refs */
  var els = {
    meta: document.getElementById("meta"),
    issues: document.getElementById("issues"),
    count: document.getElementById("issueCount"),
    status: document.getElementById("llmStatus"),
    run: document.getElementById("btnRun"),
    mock: document.getElementById("btnMock"),
    sample: document.getElementById("btnSample"),
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
    confidence: document.getElementById("fConfidence")
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
  var SEV_RANK = { high: 3, medium: 2, low: 1 };
  var HISTORY_KEY = "ai-code-reviewer.review-history.v1";
  var HISTORY_LIMIT = 12;
  var historyLastFocus = null;
  var historyStorageError = "";

  /* ---------------------------------------------------------- code editor */
  var cm = CodeMirror.fromTextArea(document.getElementById("editor"), {
    lineNumbers: true,
    mode: "python",
    indentUnit: 4,
    tabSize: 4,
    theme: "material-darker",
    viewportMargin: Infinity,
    extraKeys: {
      "Ctrl-Enter": function () { runReview(); },
      "Cmd-Enter": function () { runReview(); }
    }
  });
  cm.setSize("100%", "100%");

  /* ------------------------------------------------------------- helpers */

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setMeta(text, level) {
    els.meta.textContent = text;
    els.meta.classList.remove("warn", "error");
    if (level) els.meta.classList.add(level);
  }

  function setStatus(state, text) {
    /* state: pending | on | off | error */
    els.status.textContent = text;
    els.status.className = "badge " + state;
  }

  function setBusy(busy) {
    isBusy = busy;
    [els.run, els.mock, els.sample, els.history].forEach(function (btn) {
      if (btn) btn.disabled = busy;
    });
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
    activeLines.forEach(function (idx) {
      cm.removeLineClass(idx, "background", "cm-highlight-line");
    });
    activeLines = [];
  }

  function clearIssueLines() {
    issueLines.forEach(function (idx) {
      cm.removeLineClass(idx, "background", "cm-line-error");
    });
    issueLines = [];
  }

  function markIssueLines(list) {
    clearIssueLines();
    list.forEach(function (issue) {
      var idx = Number(issue.line) - 1;
      if (idx >= 0 && idx < cm.lineCount() && issueLines.indexOf(idx) === -1) {
        cm.addLineClass(idx, "background", "cm-line-error");
        issueLines.push(idx);
      }
    });
  }

  /* -------------------------------------------------------------- filter */

  function filteredIssues() {
    var t = els.type.value;
    var s = els.severity.value;
    var c = els.confidence.value;
    return allIssues
      .filter(function (issue) {
        if (t && issue.type !== t) return false;
        if (s && issue.severity !== s) return false;
        if (c && issue.confidence !== c) return false;
        return true;
      })
      .sort(function (a, b) {
        /* Cùng thứ tự với pipeline backend: dòng tăng dần, severity giảm dần */
        return (Number(a.line) || 0) - (Number(b.line) || 0) ||
          (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0);
      });
  }

  /* -------------------------------------------------------------- render */

  function emptyState(title, sub) {
    var wrap = el("div", "empty");
    wrap.innerHTML =
      '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z"></path>' +
      '<path d="m9 12 2 2 4-4"></path></svg>';
    wrap.appendChild(el("div", "empty-title", title));
    wrap.appendChild(el("div", "empty-sub", sub));
    return wrap;
  }

  function renderIssues() {
    var list = filteredIssues();

    clearActiveLines();
    els.issues.innerHTML = "";
    els.count.textContent = String(list.length);
    els.count.title = list.length + " / " + allIssues.length + " lỗi hiển thị";

    markIssueLines(list);

    if (!list.length) {
      if (allIssues.length) {
        els.issues.appendChild(emptyState(
          "Không có lỗi khớp bộ lọc",
          "Thử bỏ bớt điều kiện lọc để xem toàn bộ kết quả."
        ));
      } else if (hasRun) {
        if (lastMeta && lastMeta.llm_error) {
          els.issues.appendChild(emptyState(
            "Không có kết quả LLM",
            "LLM chưa cấu hình hoặc gặp lỗi — xem thanh trạng thái bên dưới."
          ));
        } else {
          els.issues.appendChild(emptyState(
            "Không phát hiện lỗi",
            "Không tìm thấy vấn đề trong đoạn mã này."
          ));
        }
      } else {
        els.issues.appendChild(emptyState(
          "Chưa có kết quả",
          "Dán code rồi bấm “Phân tích” để bắt đầu."
        ));
      }
      return;
    }

    list.forEach(function (issue) {
      var index = allIssues.indexOf(issue);

      var card = el("div", "issue " + issue.type);
      card.dataset.index = String(index);
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label",
        "Lỗi dòng " + issue.line + ": " + (issue.message || issue.type));

      var head = el("div", "issue-head");
      head.appendChild(el("span", "line", "Dòng " + issue.line));
      head.appendChild(el("span", "tag " + issue.type, issue.type));
      head.appendChild(el("span", "chip sev-" + issue.severity, "mức " + issue.severity));
      if (issue.cwe_id) {
        head.appendChild(el("span", "chip cwe", issue.cwe_id));
      }
      card.appendChild(head);

      card.appendChild(el("div", "msg", issue.message || "(không có mô tả)"));
      if (issue.explanation) card.appendChild(el("div", "explanation", issue.explanation));
      if (issue.suggestion) card.appendChild(el("div", "suggestion", issue.suggestion));

      function activate() { selectIssue(index, true); }
      card.addEventListener("click", activate);
      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });

      els.issues.appendChild(card);
    });
  }

  /* -------------------------------------------------------------- select */

  function selectIssue(index, scrollToLine) {
    clearActiveLines();
    if (index < 0 || index >= allIssues.length) return;

    var issue = allIssues[index];
    var idx = Number(issue.line) - 1;

    if (idx >= 0 && idx < cm.lineCount()) {
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

  /* Bấm / di chuyển trong code -> chọn lỗi tương ứng bên phải */
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

    /* Dòng không có lỗi (hoặc lỗi đang bị lọc) -> bỏ chọn */
    clearActiveLines();
    Array.prototype.forEach.call(document.querySelectorAll(".issue.active"), function (card) {
      card.classList.remove("active");
    });
  });

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

  function requestReview(url, btn, busyLabel, requireCode) {
    if (isBusy) return;

    var code = cm.getValue();
    if (requireCode && !code.trim()) {
      setMeta("Mã nguồn trống — hãy dán code trước khi phân tích.", "warn");
      return;
    }
    if (requireCode && maxCodeLength && code.length > maxCodeLength) {
      setMeta(
        "Mã nguồn quá dài (" + code.length.toLocaleString("vi-VN") +
        " > " + maxCodeLength.toLocaleString("vi-VN") + " ký tự).",
        "warn"
      );
      return;
    }

    var stopLoading = startLoading(btn, busyLabel);
    setBusy(true);

    fetch(API + url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code,
        filename: "snippet.py",
        mode: els.mode.value
      })
    })
      .catch(function (err) {
        err.isNetwork = true;
        throw err;
      })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw new Error(responseError(body, res));
          return body;
        });
      })
      .then(function (data) {
        var savedToHistory = saveHistory(code, data);
        hasRun = true;
        lastMeta = data.meta || {};
        allIssues = Array.isArray(data.issues) ? data.issues : [];
        clearActiveLines();
        renderIssues();
        els.issues.scrollTop = 0;
        showMeta(lastMeta, allIssues.length);
        if (!savedToHistory) {
          setMeta("Tìm thấy " + allIssues.length + " lỗi · Không thể lưu lịch sử trên trình duyệt.", "warn");
        }
        if (els.status.classList.contains("error")) checkHealth();
      })
      .catch(function (err) {
        if (err.isNetwork) {
          setMeta("Không kết nối được server: " + err.message, "error");
          setStatus("error", "Mất kết nối server");
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
    requestReview("/review", els.run, "Đang phân tích…", true);
  }

  function runMockReview() {
    if (isBusy) return;

    /* Demo một chạm: nếu editor trống, nạp code mẫu để highlight dòng hoạt động */
    if (cm.getValue().trim()) {
      requestReview("/mock/review", els.mock, "Đang tạo dữ liệu…", false);
      return;
    }

    var stopLoading = startLoading(els.mock, "Đang tải mẫu…");
    setBusy(true);

    fetch(API + "/sample")
      .catch(function (err) {
        err.isNetwork = true;
        throw err;
      })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        cm.setValue(data.code || "");
        stopLoading();
        setBusy(false);
        requestReview("/mock/review", els.mock, "Đang tạo dữ liệu…", false);
      })
      .catch(function (err) {
        stopLoading();
        setBusy(false);
        if (err.isNetwork) {
          setMeta("Không kết nối được server: " + err.message, "error");
          setStatus("error", "Mất kết nối server");
        } else {
          setMeta("Không tải được mã mẫu: " + err.message, "error");
        }
      });
  }

  function loadSample() {
    if (isBusy) return;

    var stopLoading = startLoading(els.sample, "Đang tải…");
    setBusy(true);

    fetch(API + "/sample")
      .catch(function (err) {
        err.isNetwork = true;
        throw err;
      })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        allIssues = [];
        hasRun = false;
        lastMeta = null;
        clearActiveLines();
        clearIssueLines();
        cm.setValue(data.code || "");
        renderIssues();
        setMeta("Đã tải mã ví dụ — bấm “Phân tích” để review.", "");
      })
      .catch(function (err) {
        if (err.isNetwork) {
          setMeta("Không kết nối được server: " + err.message, "error");
          setStatus("error", "Mất kết nối server");
        } else {
          setMeta("Không tải được mã ví dụ: " + err.message, "error");
        }
      })
      .finally(function () {
        setBusy(false);
        stopLoading();
      });
  }

  /* --------------------------------------------------------------- events */

  els.run.addEventListener("click", runReview);

  els.mock.addEventListener("click", runMockReview);

  els.sample.addEventListener("click", loadSample);

  [els.type, els.severity, els.confidence].forEach(function (select) {
    select.addEventListener("change", renderIssues);
  });

  els.reset.addEventListener("click", function () {
    if (els.type) els.type.value = "";
    if (els.severity) els.severity.value = "";
    if (els.confidence) els.confidence.value = "";
    renderIssues();
  });

  /* ----------------------------------------------------- local history */

  function isHistoryEntry(entry) {
    return entry && typeof entry.id === "string" && typeof entry.code === "string" &&
      Array.isArray(entry.issues) && entry.meta && typeof entry.meta === "object";
  }

  function readHistory() {
    historyStorageError = "";
    try {
      var raw = window.localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      var entries = JSON.parse(raw);
      if (!Array.isArray(entries)) throw new Error("Dữ liệu lịch sử không hợp lệ");
      return entries.filter(isHistoryEntry).slice(0, HISTORY_LIMIT);
    } catch (err) {
      historyStorageError = "Không thể đọc Local Storage.";
      return null;
    }
  }

  function writeHistory(entries) {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
      historyStorageError = "";
      return true;
    } catch (err) {
      historyStorageError = "Không thể ghi Local Storage.";
      return false;
    }
  }

  function saveHistory(code, data) {
    var entries = readHistory();
    if (entries === null) return false;
    entries.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      createdAt: new Date().toISOString(),
      code: String(code || ""),
      issues: Array.isArray(data.issues) ? data.issues : [],
      meta: data.meta && typeof data.meta === "object" ? data.meta : { mode: "?" }
    });
    return writeHistory(entries);
  }

  function setHistoryEmpty(title, sub) {
    if (!els.historyEmpty) return;
    els.historyEmpty.style.display = "flex";
    var titleEl = els.historyEmpty.querySelector(".empty-title");
    var subEl = els.historyEmpty.querySelector(".empty-sub");
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = sub;
  }

  function historyTitle(code) {
    var lines = String(code || "").split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim().replace(/\s+/g, " ");
      if (line) return line.length > 58 ? line.slice(0, 57) + "…" : line;
    }
    return "Đoạn mã Python";
  }

  function formatHistoryTime(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Không rõ thời gian";
    try {
      return date.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
    } catch (err) {
      return date.toLocaleString("vi-VN");
    }
  }

  function renderHistory() {
    if (!els.historyList) return;
    els.historyList.innerHTML = "";
    var entries = readHistory();
    if (entries === null) {
      setHistoryEmpty("Không thể mở lịch sử", historyStorageError);
      return;
    }
    if (!entries.length) {
      setHistoryEmpty("Chưa có lịch sử", "Kết quả review sẽ được lưu tự động trên trình duyệt này.");
      return;
    }

    if (els.historyEmpty) els.historyEmpty.style.display = "none";
    entries.forEach(function (entry) {
      var item = el("article", "history-item");
      var copy = el("div", "history-item-copy");
      copy.appendChild(el("div", "history-item-title", historyTitle(entry.code)));
      copy.appendChild(el(
        "div",
        "history-item-meta",
        formatHistoryTime(entry.createdAt) + " · " + (entry.issues.length || 0) + " lỗi · " + (entry.meta.mode || "?")
      ));
      item.appendChild(copy);

      var actions = el("div", "history-item-actions");
      var restore = el("button", "btn", "Mở");
      restore.type = "button";
      restore.addEventListener("click", function () { restoreHistory(entry); });
      actions.appendChild(restore);

      var remove = el("button", "btn ghost danger", "Xóa");
      remove.type = "button";
      remove.addEventListener("click", function () { removeHistory(entry.id); });
      actions.appendChild(remove);
      item.appendChild(actions);
      els.historyList.appendChild(item);
    });
  }

  function restoreHistory(entry) {
    cm.setValue(entry.code);
    if (els.mode && ["bandit", "llm", "hybrid"].indexOf(entry.meta.mode) !== -1) {
      els.mode.value = entry.meta.mode;
    }
    els.type.value = "";
    els.severity.value = "";
    els.confidence.value = "";
    allIssues = entry.issues;
    lastMeta = entry.meta;
    hasRun = true;
    clearActiveLines();
    renderIssues();
    els.issues.scrollTop = 0;
    setMeta("Đã khôi phục " + allIssues.length + " lỗi · " + formatHistoryTime(entry.createdAt));
    closeHistoryModal();
  }

  function removeHistory(id) {
    var entries = readHistory();
    if (entries === null) {
      setHistoryEmpty("Không thể mở lịch sử", historyStorageError);
      return;
    }
    if (writeHistory(entries.filter(function (entry) { return entry.id !== id; }))) {
      renderHistory();
    } else {
      setHistoryEmpty("Không thể cập nhật lịch sử", historyStorageError);
    }
  }

  function clearHistory() {
    if (!window.confirm("Xóa toàn bộ lịch sử review trên trình duyệt này?")) return;
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
    if (!els.historyModal) return;
    historyLastFocus = document.activeElement;
    els.historyModal.classList.add("active");
    els.historyModal.setAttribute("aria-hidden", "false");
    renderHistory();
    setTimeout(function () { if (els.historyClose) els.historyClose.focus(); }, 0);
  }

  function closeHistoryModal() {
    if (!els.historyModal) return;
    els.historyModal.classList.remove("active");
    els.historyModal.setAttribute("aria-hidden", "true");
    if (historyLastFocus && typeof historyLastFocus.focus === "function") historyLastFocus.focus();
    historyLastFocus = null;
  }

  if (els.history) {
    els.history.addEventListener("click", function (e) {
      if (e && e.preventDefault) e.preventDefault();
      openHistoryModal();
    });
  }
  if (els.historyClose) {
    els.historyClose.addEventListener("click", closeHistoryModal);
  }
  if (els.historyClear) {
    els.historyClear.addEventListener("click", clearHistory);
  }
  if (els.historyBackdrop) {
    els.historyBackdrop.addEventListener("click", closeHistoryModal);
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && els.historyModal && els.historyModal.classList.contains("active")) {
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
        if (health && health.llm_enabled) {
          setStatus("on", "LLM: sẵn sàng");
        } else {
          setStatus("off", "LLM: chưa cấu hình (chỉ Bandit)");
        }
      })
      .catch(function () {
        setStatus("error", "Không kết nối được server");
      });
  }

  checkHealth();
})();
