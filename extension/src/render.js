const TYPES = ["security", "bug", "quality"];
const LEVELS = ["high", "medium", "low"];
const SOURCES = ["bandit", "llm", "both"];

const TYPE_LABEL = { security: "Security", bug: "Bug", quality: "Quality" };
const SOURCE_LABEL = { bandit: "Bandit", llm: "LLM", both: "Bandit + LLM" };
const LEVEL_ORDER = { high: 3, medium: 2, low: 1 };

// Tạo phần tử, gán chữ bằng textContent (an toàn trước XSS)
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// Chỉ cho phép các giá trị đã biết làm tên class
const safe = (value, allowed) => (allowed.includes(value) ? value : "unknown");

export function sortIssues(issues) {
  return [...issues].sort(
    (a, b) =>
      (LEVEL_ORDER[b.severity] || 0) - (LEVEL_ORDER[a.severity] || 0) ||
      (a.line || 0) - (b.line || 0)
  );
}

export function filterIssues(issues, { severity, confidence }) {
  return issues.filter(
    (i) =>
      (severity === "all" || i.severity === severity) &&
      (confidence === "all" || i.confidence === confidence)
  );
}

function badge(text, kind) {
  return el("span", `badge ${kind}`, text);
}

function createCard(issue) {
  const type = safe(issue.type, TYPES);
  const severity = safe(issue.severity, LEVELS);
  const confidence = safe(issue.confidence, LEVELS);

  const card = el("article", `card type-${type}`);

  // --- Phần đầu (bấm để mở/đóng) ---
  const header = el("button", "card-header");
  header.type = "button";
  header.setAttribute("aria-expanded", "false");

  const badges = el("div", "badges");
  badges.append(
    badge(TYPE_LABEL[type] ?? "Khác", `tag type-${type}`),
    badge(`Mức: ${severity}`, `tag sev-${severity}`),
    badge(`Tin cậy: ${confidence}`, `tag conf-${confidence}`)
  );

  const title = el("div", "title", issue.message || "(không có tiêu đề)");
  const meta = el(
    "div",
    "meta",
    `Dòng ${issue.line ?? "?"} · Nguồn: ${SOURCE_LABEL[safe(issue.source, SOURCES)] ?? "?"}`
  );
  header.append(badges, title, meta);

  // --- Phần chi tiết (ẩn lúc đầu) ---
  const body = el("div", "card-body");
  body.hidden = true;

  // cwe_id có thể là null, chuỗi rỗng hoặc thiếu hẳn
  if (issue.cwe_id) body.append(el("div", "cwe", issue.cwe_id));

  body.append(el("p", "explanation", issue.explanation || "Không có giải thích."));

  if (issue.suggestion) {
    const sugHead = el("div", "sug-head");
    sugHead.append(el("span", "sug-label", "Đề xuất sửa"));
    const copyBtn = el("button", "copy-btn", "Sao chép");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(issue.suggestion);
        copyBtn.textContent = "Đã chép";
      } catch {
        copyBtn.textContent = "Không chép được";
      }
      setTimeout(() => (copyBtn.textContent = "Sao chép"), 1500);
    });
    sugHead.append(copyBtn);
    body.append(sugHead, el("pre", "suggestion", issue.suggestion));
  }

  header.addEventListener("click", () => {
    const open = body.hidden; // đang ẩn thì sắp mở
    body.hidden = !open;
    header.setAttribute("aria-expanded", String(open));
  });

  card.append(header, body);
  return card;
}

export function renderIssues(container, issues) {
  container.replaceChildren();
  if (issues.length === 0) {
    container.append(el("p", "empty", "Không có lỗi nào phù hợp."));
    return;
  }
  issues.forEach((issue) => container.append(createCard(issue)));
}