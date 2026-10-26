import { reviewCode, getHealth, normalizeCode, abortCurrentRequest, getSampleCode } from "../src/api.js";
import { renderIssues, filterIssues, sortIssues } from "../src/render.js";
import { getSettings, saveSettings } from "../src/storage.js";
import { LOCAL_URL, DEPLOY_URL } from "../src/config.js";

const $ = (id) => document.getElementById(id);

// Status bar elements
const backendStatusEl = $("backend-status");
const backendStatusText = $("backend-status-text");
const openWebLink = $("open-web");

// Input section elements
const codeInput = $("code-input");
const codeStats = $("code-stats");
const codeHint = $("code-hint");
const analyzingOverlay = $("analyzing-overlay");
const emptyState = $("empty-state");
const btnExample = $("btn-example");

// Mode elements
const segmentButtons = document.querySelectorAll(".segment[data-mode]");
const modeDesc = $("mode-desc");
const modeHint = $("mode-hint");

// Action buttons
const btnAnalyze = $("btn-analyze");
const btnCancel = $("btn-cancel");
const btnClear = $("btn-clear");
const btnEditCode = $("btn-edit-code");

// Result elements
const resultHeader = $("result-header");
const resultSummaryLine1 = $("result-summary-line1");
const resultSummaryLine2 = $("result-summary-line2");

// Filter elements
const typeChips = document.querySelectorAll(".chip[data-type] input");
const filterSeverity = $("filter-severity");
const filterConfidence = $("filter-confidence");
const filterSection = $("filter-section");
const resultsCount = $("results-count");
const resultsShown = $("results-shown");
const resultsTotal = $("results-total");

// Issues & Banner
const issuesList = $("issues");
const bannerArea = $("banner-area");

// State
let allIssues = [];
let filteredIssues = [];
let llmEnabled = true;
let maxCodeLength = 20000;
let lastAnalyzeCode = "";
let lastAnalyzeMode = "hybrid";
let isAnalyzing = false;
let backendOnline = false;
let currentTypeFilter = "all";
let currentSeverity = "all";
let currentConfidence = "all";

const PYTHON_KEYWORDS = ["def ", "import ", "class ", "return ", "print(", "if ", "for ", "while "];
const EXAMPLE_CODE = `import os
import sqlite3
import subprocess

PASSWORD = "admin123"


def get_user(conn, user_id):
    query = "SELECT * FROM users WHERE id = " + user_id
    return conn.execute(query).fetchone()


def run_cmd(cmd):
    return subprocess.call(cmd, shell=True)


def total(values):
    return sum(values) / len(values)
`;

// Mode descriptions
const MODE_DESCRIPTIONS = {
  bandit: "Bandit: Chỉ SAST — nhanh, không cần API key, cơ sở bảo mật cơ bản",
  llm: "LLM: Chỉ AI — tìm bug & quality, cần API key",
  hybrid: "Hybrid (Khuyên dùng): Bandit + LLM — ít báo nhầm hơn, bắt thêm lỗi bug/quality"
};

// Severity/Confidence labels
const SEV_LABELS = { high: "High", medium: "Medium", low: "Low" };
const CONF_LABELS = { high: "High", medium: "Medium", low: "Low" };

// --- Helpers ---
function updateCodeStats() {
  const code = codeInput.value;
  const lines = code ? code.split("\n").length : 0;
  const chars = code.length;
  codeStats.textContent = `${lines} dòng · ${chars.toLocaleString()} / ${maxCodeLength.toLocaleString()} ký tự`;
  codeStats.classList.toggle("warning", chars > maxCodeLength);
}

function setBackendStatus(healthy, enabled) {
  backendOnline = healthy;
  llmEnabled = enabled;
  if (healthy) {
    backendStatusText.textContent = `Sẵn sàng · LLM: ${enabled ? "bật" : "tắt"}`;
    backendStatusEl.classList.remove("offline");
    backendStatusEl.classList.add("online");
  } else {
    backendStatusText.textContent = "Chưa kết nối";
    backendStatusEl.classList.add("offline");
    backendStatusEl.classList.remove("online");
  }
  updateModeHint();
  updateSegmentStates();
}

function updateModeHint() {
  const mode = getCurrentMode();
  if (backendOnline && llmEnabled === false && (mode === "llm" || mode === "hybrid")) {
    modeHint.textContent = "LLM chưa cấu hình trên máy chủ, kết quả có thể chỉ có Bandit";
    modeHint.hidden = false;
  } else {
    modeHint.hidden = true;
  }
}

function updateSegmentStates() {
  const mode = getCurrentMode();
  segmentButtons.forEach(btn => {
    const isActive = btn.dataset.mode === mode;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-checked", isActive);
  });
  modeDesc.textContent = MODE_DESCRIPTIONS[mode] || "";
}

function getCurrentMode() {
  const active = document.querySelector(".segment.active");
  return active ? active.dataset.mode : "hybrid";
}

function setAnalyzing(analyzing) {
  isAnalyzing = analyzing;
  btnAnalyze.disabled = analyzing;
  btnCancel.hidden = !analyzing;
  btnClear.disabled = analyzing;
  btnEditCode.disabled = analyzing;
  codeInput.disabled = analyzing;
  
  const btnText = btnAnalyze.querySelector(".btn-text");
  if (analyzing) {
    btnText.innerHTML = '<span class="spinner"></span> Đang phân tích...';
    analyzingOverlay.hidden = false;
    emptyState.hidden = true;
    resultHeader.hidden = true;
    filterSection.hidden = true;
    resultsCount.hidden = true;
    typeChips.forEach(c => c.closest(".chip").style.display = "none");
    bannerArea.hidden = true;
  } else {
    btnText.textContent = "Phân tích";
    analyzingOverlay.hidden = true;
  }
}

function showBanner(type, title, text, showRetry = false) {
  const retryBtnHtml = showRetry ? `<button id="btn-retry" type="button" class="btn btn-primary" style="padding:6px 12px;font-size:12px;height:auto;">Thử lại</button>` : "";
  bannerArea.innerHTML = `
    <div class="banner ${type}" role="alert">
      <svg class="icon icon-md" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        ${type === "error" ? '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>' : type === "warning" ? '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>' : '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>'}
      </svg>
      <div class="banner-content">
        <div class="banner-title">${title}</div>
        <div class="banner-text">${text}</div>
        <div class="banner-actions">${retryBtnHtml}</div>
      </div>
    </div>
  `;
  bannerArea.hidden = false;
  
  const retryBtn = $("btn-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => analyze(lastAnalyzeCode));
  }
}

function hideBanner() {
  bannerArea.hidden = true;
  bannerArea.innerHTML = "";
}

function showEmptyState() {
  emptyState.hidden = false;
  resultHeader.hidden = true;
  filterSection.hidden = true;
  resultsCount.hidden = true;
  issuesList.innerHTML = "";
  typeChips.forEach(c => c.closest(".chip").style.display = "none");
  hideBanner();
}

function showResultHeader(issues, modeLabel) {
  const counts = { security: 0, bug: 0, quality: 0 };
  for (const issue of issues) {
    if (counts[issue.type] !== undefined) counts[issue.type]++;
  }
  
  resultSummaryLine1.textContent = `Đã phân tích ${issues.length} dòng · ${modeLabel}`;
  const parts = [];
  if (counts.security) parts.push(`${counts.security} Security`);
  if (counts.bug) parts.push(`${counts.bug} Bug`);
  if (counts.quality) parts.push(`${counts.quality} Quality`);
  resultSummaryLine2.textContent = parts.length ? parts.join(" · ") : "Không phát hiện lỗi";
  
  // Update chip counts
  document.getElementById("chip-count-all").textContent = issues.length;
  document.getElementById("chip-count-security").textContent = counts.security;
  document.getElementById("chip-count-bug").textContent = counts.bug;
  document.getElementById("chip-count-quality").textContent = counts.quality;
  
  resultHeader.hidden = false;
  filterSection.hidden = false;
  resultsCount.hidden = false;
  typeChips.forEach(c => c.closest(".chip").style.display = "");
  updateResultsCount();
}

function updateResultsCount() {
  resultsShown.textContent = filteredIssues.length;
  resultsTotal.textContent = allIssues.length;
  resultsCount.hidden = false;
}

function updateTypeChips() {
  const counts = { security: 0, bug: 0, quality: 0 };
  for (const issue of allIssues) {
    if (counts[issue.type] !== undefined) counts[issue.type]++;
  }
  document.getElementById("chip-count-all").textContent = allIssues.length;
  document.getElementById("chip-count-security").textContent = counts.security;
  document.getElementById("chip-count-bug").textContent = counts.bug;
  document.getElementById("chip-count-quality").textContent = counts.quality;
}

function setTypeFilter(type) {
  currentTypeFilter = type;
  typeChips.forEach(input => {
    input.checked = input.dataset.type === type || type === "all";
  });
  applyFilters();
}

function applyFilters() {
  filteredIssues = allIssues.filter(issue => {
    const typeMatch = currentTypeFilter === "all" || issue.type === currentTypeFilter;
    const sevMatch = currentSeverity === "all" || issue.severity === currentSeverity;
    const confMatch = currentConfidence === "all" || issue.confidence === currentConfidence;
    return typeMatch && sevMatch && confMatch;
  });
  updateResultsCount();
  renderIssues(issuesList, sortIssues(filteredIssues));
}

// --- Event Handlers ---
function handleModeChange(mode) {
  const btn = document.querySelector(`.segment[data-mode="${mode}"]`);
  if (btn) {
    segmentButtons.forEach(b => {
      b.classList.remove("active");
      b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-checked", "true");
    modeDesc.textContent = MODE_DESCRIPTIONS[mode] || "";
    updateModeHint();
  }
}

async function analyze(code) {
  const normalized = normalizeCode(code);
  if (!normalized) {
    showBanner("error", "Không có code", "Vui lòng dán code hoặc bôi đen code trên trang web.");
    return;
  }

  const isPython = PYTHON_KEYWORDS.some(kw => normalized.toLowerCase().includes(kw));
  if (!isPython) {
    codeHint.textContent = "Đoạn này có vẻ không phải code Python";
    codeHint.hidden = false;
  } else {
    codeHint.hidden = true;
  }

  if (normalized.length > maxCodeLength) {
    showBanner("error", "Code quá dài", `Độ dài ${normalized.length.toLocaleString()} ký tự vượt giới hạn ${maxCodeLength.toLocaleString()}.`);
    return;
  }

  const settings = await getSettings();
  lastAnalyzeCode = normalized;
  lastAnalyzeMode = settings.mode;

  setAnalyzing(true);
  hideBanner();

  try {
    const result = await reviewCode(normalized, { mode: settings.mode });
    allIssues = result.issues;
    const modeLabel = result.meta?.mode || settings.mode;

    setBackendStatus(true, llmEnabled);

    if (result.meta?.llm_error) {
      showBanner("warning", "LLM gặp lỗi", "Đang hiển thị kết quả chỉ từ Bandit.");
    } else if (allIssues.length === 0) {
      showBanner("success", "Không phát hiện lỗi", `Chế độ ${modeLabel} không tìm thấy vấn đề nào.`);
    }

    showResultHeader(allIssues, modeLabel);
    applyFilters();
  } catch (err) {
    if (err.message === "cancelled") {
      setAnalyzing(false);
      showEmptyState();
      return;
    }
    allIssues = [];
    handleError(err);
  } finally {
    setAnalyzing(false);
  }
}

function handleError(err) {
  const isNetworkError = err.message === "Không kết nối được máy chủ";
  const isTimeout = err.message?.includes("timeout") || err.name === "AbortError";

  if (isNetworkError || isTimeout) {
    showBanner("error", "Không kết nối được máy chủ", "Hãy chạy backend (python -m uvicorn app.main:app --app-dir backend --port 8000) hoặc đặt USE_MOCK = true trong src/config.js.", true);
    setBackendStatus(false, llmEnabled);
  } else {
    const retryable = err.message?.includes("5xx") || err.message?.includes("Máy chủ gặp lỗi");
    showBanner("error", err.message, retryable ? "Có thể thử lại sau vài giây." : "", retryable);
  }
}

function handleCancel() {
  abortCurrentRequest();
}

function clearAll() {
  codeInput.value = "";
  updateCodeStats();
  codeHint.hidden = true;
  lastAnalyzeCode = "";
  allIssues = [];
  filteredIssues = [];
  filterSeverity.value = "all";
  filterConfidence.value = "all";
  setTypeFilter("all");
  showEmptyState();
}

async function loadExampleCode() {
  const sampleCode = await getSampleCode();
  const code = sampleCode || EXAMPLE_CODE;
  codeInput.value = code;
  updateCodeStats();
  analyze(code);
}

function handleTypeChipChange(e) {
  const type = e.target.dataset.type;
  setTypeFilter(type);
}

function handleSeverityChange() {
  currentSeverity = filterSeverity.value;
  applyFilters();
}

function handleConfidenceChange() {
  currentConfidence = filterConfidence.value;
  applyFilters();
}

let healthCheckInFlight = false;

async function checkHealth() {
  // Prevent focus/click events from starting overlapping health checks.
  if (healthCheckInFlight) return;
  healthCheckInFlight = true;

  let timeoutId;
  try {
    // A stalled backend must not leave the status pill in "checking" forever.
    const health = await Promise.race([
      getHealth(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("health-timeout")), 5000);
      })
    ]);

    if (health) {
      maxCodeLength = health.max_code_length || 20000;
    }
    setBackendStatus(!!health, health?.llm_enabled);
  } catch (err) {
    setBackendStatus(false, false);
  } finally {
    clearTimeout(timeoutId);
    healthCheckInFlight = false;
    updateCodeStats();
  }
}

async function initMode() {
  const settings = await getSettings();
  handleModeChange(settings.mode);
  
  segmentButtons.forEach(btn => {
    btn.addEventListener("click", () => handleModeChange(btn.dataset.mode));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleModeChange(btn.dataset.mode);
      }
    });
  });
}

function initOpenWebLink() {
  const url = DEPLOY_URL || LOCAL_URL;
  openWebLink.href = url;
}

function initInputHandlers() {
  btnAnalyze.addEventListener("click", () => analyze(codeInput.value));
  btnCancel.addEventListener("click", handleCancel);
  btnClear.addEventListener("click", clearAll);
  btnEditCode.addEventListener("click", () => {
    resultHeader.hidden = true;
    filterSection.hidden = true;
    resultsCount.hidden = true;
    typeChips.forEach(c => c.closest(".chip").style.display = "none");
    issuesList.innerHTML = "";
    codeInput.focus();
  });

  codeInput.addEventListener("input", updateCodeStats);
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      analyze(codeInput.value);
    }
  });

  // Type chips
  typeChips.forEach(input => {
    input.addEventListener("change", handleTypeChipChange);
  });

  filterSeverity.addEventListener("change", handleSeverityChange);
  filterConfidence.addEventListener("change", handleConfidenceChange);

  // Backend status click to re-check
  backendStatusEl.addEventListener("click", () => {
    if (!isAnalyzing) checkHealth();
  });

  // Window focus to re-check health
  window.addEventListener("focus", () => {
    if (!isAnalyzing) checkHealth();
  });
}

// --- Init ---
chrome.storage.session.get("pendingCode").then(({ pendingCode }) => {
  checkHealth();
  initMode();
  initOpenWebLink();
  initInputHandlers();
  
  if (pendingCode) {
    codeInput.value = pendingCode;
    updateCodeStats();
    analyze(pendingCode);
  } else {
    showEmptyState();
  }
});