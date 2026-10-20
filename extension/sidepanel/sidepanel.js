import { reviewCode } from "../src/api.js";
import { renderIssues, filterIssues, sortIssues } from "../src/render.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const summaryEl = $("summary");
const listEl = $("issues");
const codeBox = $("code-box");
const codeEl = $("code");
const sevSel = $("filter-severity");
const confSel = $("filter-confidence");

let allIssues = [];

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
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
    codeEl.textContent = code;
    codeBox.hidden = false;
  }
  setStatus("Đang phân tích...");
  listEl.replaceChildren();
  summaryEl.textContent = "";
  try {
    allIssues = await reviewCode(code);
    setStatus(allIssues.length ? "Hoàn tất." : "Không phát hiện lỗi nào.");
    refresh();
  } catch (err) {
    allIssues = [];
    setStatus(`Có lỗi: ${err.message}`, true);
  }
}

sevSel.addEventListener("change", refresh);
confSel.addEventListener("change", refresh);

// Khi bôi đen đoạn code mới lúc panel đang mở
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pendingCode?.newValue) {
    analyze(changes.pendingCode.newValue);
  }
});

// Lần đầu mở panel
chrome.storage.session.get("pendingCode").then(({ pendingCode }) => {
  analyze(pendingCode || "");
});