import { reviewCode, getHealth, cancelReview } from "../src/api.js";
import { renderIssues, filterIssues, sortIssues, showSkeleton, makeIcon } from "../src/render.js";
import { getSettings, saveSettings } from "../src/storage.js";
import { LOCAL_URL, DEPLOY_URL } from "../src/config.js";

const $ = (id) => document.getElementById(id);
const srStatus = $("sr-status");
const healthPill = $("health-pill");
const healthPillText = $("health-pill-text");
const listEl = $("issues");
const bannerEl = $("banner");
const resultControls = $("result-controls");
const offlineGuide = $("offline-guide");
const serverCommand = $("server-command");
const copyCommandBtn = $("copy-command");
const codeInput = $("code-input");
const codeCounter = $("code-counter");
const codeLimit = $("code-limit");
const filterType = $("filter-type");
const filterSeverity = $("filter-severity");
const filterConfidence = $("filter-confidence");
const modeSelect = $("mode-select");
const btnAnalyze = $("btn-analyze");
const btnCancel = $("btn-cancel");
const btnClear = $("btn-clear");
const openWeb = $("open-web");
const themeSelect = $("theme-select");
const resultCount = $("result-count");

const HEALTH_CLASSES = ["is-checking", "is-ok", "is-ok-no-llm", "is-offline"];

const state = {
  health: "checking",
  review: "idle",
  issues: [],
  meta: null,
  error: null,
  sourceNotice: "",
  lastCode: "",
  maxCodeLength: 20000,
  healthRequestId: 0,
  reviewRequestId: 0
};

function announce(message) {
  srStatus.textContent = message;
}

function clearBanner() {
  bannerEl.replaceChildren();
}

function bannerIcon(kind) {
  const svg = makeIcon(kind);
  svg.classList.remove("empty-icon");
  svg.classList.add("banner-icon");
  return svg;
}

function showBanner(kind, title, text, actions = [], compact = false) {
  const banner = document.createElement("div");
  banner.className = `banner banner-${kind}${compact ? " banner-compact" : ""}`;
  banner.append(bannerIcon(kind === "err" ? "error" : kind === "warn" ? "warn" : "empty"));

  const copy = document.createElement("div");
  copy.className = "banner-copy";

  const heading = document.createElement("div");
  heading.className = "banner-title";
  heading.textContent = title;
  copy.append(heading);

  if (text) {
    const body = document.createElement("div");
    body.className = "banner-text";
    body.textContent = text;
    copy.append(body);
  }

  if (actions.length) {
    const row = document.createElement("div");
    row.className = "banner-actions";
    actions.forEach(({ label, onClick, primary }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn ${primary ? "btn-primary" : "btn-secondary"}`;
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      row.append(btn);
    });
    copy.append(row);
  }

  banner.append(copy);
  bannerEl.append(banner);
}

function renderHealth() {
  healthPill.classList.remove(...HEALTH_CLASSES);
  healthPill.classList.add(`is-${state.health.replace(/_/g, "-")}`);

  const labels = {
    checking: "Đang kiểm tra…",
    ok: "Sẵn sàng",
    ok_no_llm: "Sẵn sàng · LLM tắt",
    offline: "Máy chủ chưa chạy"
  };
  healthPillText.textContent = labels[state.health];
}

function renderBanners() {
  clearBanner();

  if (state.sourceNotice) {
    showBanner(
      "warn",
      "Nguồn code từ GitHub chưa đầy đủ",
      state.sourceNotice,
      [
        {
          label: "Đã hiểu",
          onClick: () => {
            state.sourceNotice = "";
            renderBanners();
          }
        }
      ]
    );
  }

  if (state.review === "error" && state.error) {
    showBanner("err", state.error.title, state.error.text, [
      {
        label: "Thử lại",
        onClick: () => analyze(state.lastCode || codeInput.value),
        primary: true
      }
    ]);
    return;
  }

  const hasLlmError = state.meta?.llm_error && state.health !== "ok_no_llm";

  if (hasLlmError) {
    showBanner(
      "warn",
      "LLM không trả về kết quả hợp lệ",
      `Đang hiển thị kết quả từ các công cụ phân tích tĩnh. Chi tiết: ${state.meta.llm_error}`,
      [{ label: "Thử lại", onClick: () => analyze(state.lastCode), primary: true }]
    );
  } else if (state.review === "done" && state.issues.length === 0) {
    showBanner("ok", "Không phát hiện vấn đề", "Không có lỗi nào được tìm thấy trong đoạn code này.");
  }

  if (state.health === "ok_no_llm" && ["llm", "filter", "hybrid"].includes(modeSelect.value)) {
    showBanner(
      "info",
      "LLM chưa được cấu hình trên máy chủ; kết quả có thể chỉ gồm Bandit.",
      "",
      [],
      true
    );
  }
}

function updateCodeCount() {
  const length = codeInput.value.length;
  codeCounter.textContent = `${length.toLocaleString("vi-VN")} ký tự`;
  codeLimit.textContent = `${state.maxCodeLength.toLocaleString("vi-VN")} ký tự`;
  codeLimit.classList.toggle("over", length > state.maxCodeLength);
}

function filteredIssues() {
  const bySeverity = filterIssues(state.issues, {
    severity: filterSeverity.value,
    confidence: filterConfidence.value
  });
  const type = filterType.value;
  return bySeverity.filter((issue) => type === "all" || issue.type === type);
}

function refreshList() {
  const filtered = sortIssues(filteredIssues());
  resultCount.textContent = `${filtered.length} lỗi`;
  renderIssues(listEl, filtered);
}

function renderResults() {
  const hasIssues = state.review === "done" && state.issues.length > 0;
  resultControls.hidden = !hasIssues;

  if (state.review === "loading") {
    offlineGuide.hidden = true;
    listEl.hidden = false;
    resultCount.textContent = "Đang tải…";
    showSkeleton(listEl, 3);
    return;
  }

  if (hasIssues) {
    offlineGuide.hidden = true;
    listEl.hidden = false;
    refreshList();
    return;
  }

  listEl.replaceChildren();
  listEl.hidden = true;
  offlineGuide.hidden = !(state.review === "idle" && state.health === "offline");
}

function render() {
  renderHealth();
  renderBanners();
  renderResults();
}

function resetReview() {
  state.reviewRequestId += 1;
  cancelReview();
  state.review = "idle";
  state.issues = [];
  state.meta = null;
  state.error = null;
  listEl.replaceChildren();
  resultCount.textContent = "0 lỗi";
}

function setCodeTabSize(value) {
  const size = Number.parseInt(value, 10);
  codeInput.style.tabSize =
    Number.isInteger(size) && size >= 1 && size <= 16 ? String(size) : "";
}

function acceptPendingCode(code, { notice = "", tabSize = "" } = {}) {
  if (typeof code !== "string") return;

  const sourceNotice = typeof notice === "string" ? notice : "";
  if (!code && !sourceNotice) return;

  resetReview();
  codeInput.value = code;
  /* Setting textarea.value may leave the viewport at the final line. Show the
     beginning of code received from a web page so it does not look truncated. */
  codeInput.setSelectionRange(0, 0);
  codeInput.scrollTop = 0;
  state.sourceNotice = sourceNotice;
  setCodeTabSize(tabSize);
  updateCodeCount();
  render();
}

async function analyze(code) {
  state.lastCode = code;

  if (!code.trim()) {
    state.review = "error";
    state.issues = [];
    state.meta = null;
    state.error = {
      title: "Chưa có mã nguồn",
      text: "Hãy dán code Python trước khi phân tích."
    };
    announce("Chưa có mã nguồn để phân tích.");
    render();
    return;
  }

  if (code.length > state.maxCodeLength) {
    state.review = "error";
    state.issues = [];
    state.meta = null;
    state.error = {
      title: "Mã nguồn quá dài",
      text: `Giới hạn hiện tại là ${state.maxCodeLength.toLocaleString("vi-VN")} ký tự. Hãy rút gọn rồi thử lại.`
    };
    announce("Mã nguồn quá dài.");
    render();
    return;
  }

  const requestId = ++state.reviewRequestId;
  state.review = "loading";
  state.issues = [];
  state.meta = null;
  state.error = null;
  announce("Đang phân tích mã nguồn.");
  render();

  try {
    const result = await reviewCode(code, { mode: modeSelect.value });
    if (requestId !== state.reviewRequestId) return;

    state.issues = Array.isArray(result.issues) ? result.issues : [];
    state.meta = result.meta || null;
    state.review = "done";
    announce(`Hoàn tất, tìm thấy ${state.issues.length} lỗi.`);
  } catch (err) {
    if (requestId !== state.reviewRequestId) return;

    if (err.message === "cancelled") {
      state.review = "idle";
      state.issues = [];
      state.meta = null;
      state.error = null;
      announce("Đã huỷ phân tích.");
    } else {
      state.review = "error";
      state.issues = [];
      state.meta = null;
      state.error = {
        title: "Không thể phân tích",
        text: `${err.message}. Kiểm tra máy chủ đang chạy và thử lại.`
      };
      announce("Không thể phân tích mã nguồn.");
    }
  } finally {
    if (requestId === state.reviewRequestId) render();
  }
}

async function checkHealth() {
  const requestId = ++state.healthRequestId;
  state.health = "checking";
  render();

  let health = null;
  try {
    health = await getHealth();
  } catch {
    health = null;
  }

  if (requestId !== state.healthRequestId) return;

  if (!health) {
    state.health = "offline";
    announce("Máy chủ chưa chạy.");
  } else {
    state.health = health.llm_enabled ? "ok" : "ok_no_llm";
    state.maxCodeLength = health.max_code_length || 20000;
    updateCodeCount();
    announce(state.health === "ok" ? "Máy chủ sẵn sàng." : "Máy chủ sẵn sàng, LLM đang tắt.");
  }

  render();
}

function cancelActiveReview() {
  if (state.review !== "loading") return;

  resetReview();
  announce("Đã huỷ phân tích.");
  render();
}

function clearAll() {
  resetReview();
  codeInput.value = "";
  codeInput.setSelectionRange(0, 0);
  codeInput.scrollTop = 0;
  state.lastCode = "";
  state.sourceNotice = "";
  setCodeTabSize("");
  filterType.value = "all";
  filterSeverity.value = "all";
  filterConfidence.value = "all";
  updateCodeCount();
  announce("Đã xoá mã nguồn và kết quả.");
  render();
}

function applyTheme(theme) {
  if (theme === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  textarea.remove();
  return copied;
}

async function copyCommand() {
  const command = serverCommand.textContent || "";
  let copied = false;

  try {
    await navigator.clipboard.writeText(command);
    copied = true;
  } catch {
    copied = fallbackCopy(command);
  }

  copyCommandBtn.textContent = copied ? "Đã sao chép" : "Sao chép thất bại";
  announce(copied ? "Đã sao chép lệnh khởi động máy chủ." : "Không sao chép được lệnh.");

  window.setTimeout(() => {
    copyCommandBtn.textContent = "Sao chép";
  }, 1500);
}

function initOpenWebLink() {
  openWeb.href = DEPLOY_URL || LOCAL_URL;
}

async function initMode() {
  modeSelect.addEventListener("change", () => {
    render();
    saveSettings({ mode: modeSelect.value });
  });

  const settings = await getSettings();
  modeSelect.value = settings.mode;
  render();
}

function initInputHandlers() {
  btnAnalyze.addEventListener("click", () => analyze(codeInput.value));
  btnClear.addEventListener("click", clearAll);
  healthPill.addEventListener("click", checkHealth);
  copyCommandBtn.addEventListener("click", copyCommand);

  codeInput.addEventListener("input", () => {
    if (state.sourceNotice) {
      state.sourceNotice = "";
      render();
    }
    updateCodeCount();
  });
  codeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      analyze(codeInput.value);
    }
  });

  themeSelect.addEventListener("change", (event) => {
    const theme = event.target.value;
    applyTheme(theme);
    localStorage.setItem("theme", theme);
  });

  filterType.addEventListener("change", refreshList);
  filterSeverity.addEventListener("change", refreshList);
  filterConfidence.addEventListener("change", refreshList);
}

function initTheme() {
  const savedTheme = localStorage.getItem("theme") || "auto";
  themeSelect.value = savedTheme;
  applyTheme(savedTheme);
}

async function init() {
  initTheme();
  initOpenWebLink();
  initInputHandlers();
  render();

  await initMode();

  const { pendingCode, pendingCodeNotice, pendingTabSize } =
    await chrome.storage.session.get([
      "pendingCode",
      "pendingCodeNotice",
      "pendingTabSize"
    ]);
  if (typeof pendingCode === "string") {
    acceptPendingCode(pendingCode, {
      notice: pendingCodeNotice,
      tabSize: pendingTabSize
    });
  }

  await checkHealth();
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancelActiveReview();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || typeof changes.pendingCode?.newValue !== "string") {
    return;
  }

  acceptPendingCode(changes.pendingCode.newValue, {
    notice: changes.pendingCodeNotice?.newValue,
    tabSize: changes.pendingTabSize?.newValue
  });
});

init();
