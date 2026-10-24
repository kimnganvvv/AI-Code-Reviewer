import { reviewCode, getHealth, normalizeCode } from "../src/api.js";
import { renderIssues, filterIssues, sortIssues } from "../src/render.js";
import { getSettings, saveSettings } from "../src/storage.js";
import { LOCAL_URL, DEPLOY_URL } from "../src/config.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const summaryEl = $("summary");
const listEl = $("issues");
const codeBox = $("code-box");
const codeEl = $("code");
const sevSel = $("filter-severity");
const confSel = $("filter-confidence");
const modeSel = $("mode-select");
const modeHint = $("mode-hint");
const codeInput = $("code-input");
const btnAnalyze = $("btn-analyze");
const btnClear = $("btn-clear");
const openWeb = $("open-web");

let allIssues = [];
let llmEnabled = true;
let maxCodeLength = 20000;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function setHealthStatus(healthy, enabled) {
  llmEnabled = enabled;
  if (healthy) {
    statusEl.textContent = `Backend: sẵn sàng · LLM: ${enabled ? "bật" : "tắt"}`;
    statusEl.classList.remove("error");
  } else {
    statusEl.textContent = "Backend: không kết nối";
    statusEl.classList.add("error");
  }
  updateModeHint();
}

function updateModeHint() {
  const mode = modeSel.value;
  if (!llmEnabled && (mode === "llm" || mode === "hybrid")) {
    modeHint.textContent = "LLM chưa cấu hình trên máy chủ, kết quả có thể chỉ có Bandit";
    modeHint.hidden = false;
  } else {
    modeHint.hidden = true;
  }
}

function clearAll() {
  codeInput.value = "";
  codeBox.hidden = true;
  codeEl.textContent = "";
  listEl.replaceChildren();
  summaryEl.textContent = "";
  allIssues = [];
  sevSel.value = "all";
  confSel.value = "all";
  setStatus("Hãy bôi đen code rồi chuột phải để review, hoặc dán code vào ô trên.");
}

// Lọc/sắp xếp lại từ dữ liệu đã có, KHÔNG gọi lại API
function refresh() {
  const filtered = filterIssues(allIssues, {
    severity: sevSel.value,
    confidence: confSel.value
  });
  summaryEl.textContent = allIssues.length
    ? `Hiển thị ${filtered.length}/${allIssues.length} lỗi`
    : "";
  renderIssues(listEl, sortIssues(filtered));
}

async function analyze(code) {
  if (code) {
    const normalized = normalizeCode(code);
    if (!normalized) {
      setStatus("Không có code để phân tích");
      codeBox.hidden = true;
      listEl.replaceChildren();
      summaryEl.textContent = "";
      allIssues = [];
      return;
    }
    codeEl.textContent = normalized;
    codeBox.hidden = false;
  }
  setStatus("Đang phân tích...");
  listEl.replaceChildren();
  summaryEl.textContent = "";
  try {
    const settings = await getSettings();
    if (code) {
      const normalized = normalizeCode(code);
      if (normalized.length > maxCodeLength) {
        setStatus(`Code quá dài (${normalized.length} ký tự, giới hạn ${maxCodeLength})`, true);
        return;
      }
    }
    const result = await reviewCode(code, { mode: settings.mode });
    allIssues = result.issues;
    const modeLabel = result.meta?.mode || settings.mode;
    let statusText = `Hoàn tất (${modeLabel}) · ${allIssues.length} lỗi`;
    if (result.meta?.llm_error) {
      statusText += " — LLM gặp lỗi, đang hiển thị kết quả Bandit";
    }
    setStatus(statusText, false);
    refresh();
  } catch (err) {
    if (err.message === "cancelled") return;
    allIssues = [];
    setStatus(`Có lỗi: ${err.message}`, true);
  }
}

async function checkHealth() {
  const health = await getHealth();
  if (health) {
    maxCodeLength = health.max_code_length || 20000;
  }
  setHealthStatus(!!health, health?.llm_enabled);
}

async function initMode() {
  const settings = await getSettings();
  modeSel.value = settings.mode;
  modeSel.addEventListener("change", async () => {
    await saveSettings({ mode: modeSel.value });
    updateModeHint();
  });
  updateModeHint();
}

function initOpenWebLink() {
  const url = DEPLOY_URL || LOCAL_URL;
  openWeb.href = url;
}

function initInputHandlers() {
  btnAnalyze.addEventListener("click", () => {
    analyze(codeInput.value);
  });

  btnClear.addEventListener("click", clearAll);

  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      analyze(codeInput.value);
    }
  });
}

sevSel.addEventListener("change", refresh);
confSel.addEventListener("change", refresh);

// Khi bôi đen đoạn code mới lúc panel đang mở
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pendingCode?.newValue) {
    const code = changes.pendingCode.newValue;
    codeInput.value = code;
    analyze(code);
  }
});

// Lần đầu mở panel
chrome.storage.session.get("pendingCode").then(({ pendingCode }) => {
  checkHealth();
  initMode();
  initOpenWebLink();
  initInputHandlers();
  if (pendingCode) {
    codeInput.value = pendingCode;
    analyze(pendingCode);
  }
});