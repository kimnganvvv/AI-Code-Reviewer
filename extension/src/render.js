const TYPES = ["security", "bug", "quality"];
const LEVELS = ["high", "medium", "low"];
const SOURCES = ["bandit", "llm", "both"];

const TYPE_LABEL = { security: "Security", bug: "Bug", quality: "Quality" };
const SOURCE_LABEL = { bandit: "Bandit", llm: "LLM", both: "Bandit + LLM" };
const LEVEL_ORDER = { high: 3, medium: 2, low: 1 };

// SVG Icons for issue types
const TYPE_ICONS = {
  security: `<svg class="icon icon-md" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`,
  bug: `<svg class="icon icon-md" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.14 9.5a3.5 3.5 0 0 0 0 5"><path d="M12 16h.01"></path><path d="M9 13a3.5 3.5 0 0 1 0 5"></path><path d="M12 16h.01"></path><path d="M12 3a6 6 0 0 0-1.4 1.2"></path><path d="M12 3a6 6 0 0 1 1.4 1.2"></path><path d="M18.5 15.5a5 5 0 0 1-2.5 4.5"></path><path d="M17.14 19.5a3.5 3.5 0 0 1 0-5"></path><path d="M5.5 15.5a5 5 0 0 0 2.5 4.5"></path><path d="M6.86 19.5a3.5 3.5 0 0 0 0-5"></path></svg>`,
  quality: `<svg class="icon icon-md" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>`
};

// Chevron icon
const CHEVRON_ICON = `<svg class="icon icon-sm chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

// Copy icon
const COPY_ICON = `<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
// Check icon for copied state
const CHECK_ICON = `<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

function safe(value, allowed) {
  return allowed.includes(value) ? value : "unknown";
}

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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function createConfidenceDots(confidence) {
  const dots = document.createElement("span");
  dots.className = `confidence-dots ${confidence}`;
  dots.setAttribute("aria-label", `Độ tin cậy: ${confidence === "high" ? "cao" : confidence === "medium" ? "trung bình" : "thấp"}`);
  dots.innerHTML = `
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
  `;
  return dots;
}

function createSeverityBadge(severity) {
  const badge = el("span", `sev-badge ${severity}`, severity.toUpperCase());
  return badge;
}

function createCweChip(cweId) {
  const chip = el("span", "cwe-chip", cweId);
  return chip;
}

export function renderIssues(container, issues) {
  container.replaceChildren();
  if (issues.length === 0) {
    const empty = el("div", "empty-results");
    empty.innerHTML = `
      <div class="icon" aria-hidden="true">
        <svg class="icon-xl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
      </div>
      <h3>Không có lỗi phù hợp</h3>
      <p>Thử thay đổi bộ lọc hoặc chạy lại phân tích.</p>
    `;
    container.append(empty);
    return;
  }
  issues.forEach((issue) => container.append(createCard(issue)));
}

function createCard(issue) {
  const type = safe(issue.type, TYPES);
  const severity = safe(issue.severity, LEVELS);
  const confidence = safe(issue.confidence, LEVELS);
  const source = safe(issue.source, SOURCES);

  const card = el("article", `issue-card type-${type}`);
  card.dataset.line = issue.line || 0;

  // Header (clickable to expand)
  const header = el("button", "issue-header");
  header.type = "button";
  header.setAttribute("aria-expanded", "false");
  header.setAttribute("aria-controls", `issue-body-${issue.line || Math.random()}`);

  // Icon
  const iconWrap = el("div", `issue-icon ${type}`);
  iconWrap.innerHTML = TYPE_ICONS[type] || TYPE_ICONS.security;
  iconWrap.setAttribute("aria-hidden", "true");

  // Main content
  const main = el("div", "issue-main");

  // Title
  const title = el("h3", "issue-title", issue.message || "(không có tiêu đề)");

  // Badges row
  const badges = el("div", "issue-badges");
  
  // Severity badge
  badges.append(createSeverityBadge(severity));
  
  // Confidence dots
  badges.append(createConfidenceDots(confidence));
  
  // CWE chip
  if (issue.cwe_id) {
    badges.append(createCweChip(issue.cwe_id));
  }

  // Meta line
  const meta = el("div", "issue-meta", `Dòng ${issue.line ?? "?"} · Nguồn: ${SOURCE_LABEL[source] ?? "?"}`);

  main.append(title, badges, meta);

  // Chevron
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.innerHTML = CHEVRON_ICON;
  chevron.setAttribute("aria-hidden", "true");

  header.append(iconWrap, main, chevron);

  // Body (collapsible)
  const bodyId = `issue-body-${issue.line || Math.random()}`;
  const body = el("div", "issue-body");
  body.id = bodyId;
  body.hidden = true;

  // Explanation
  if (issue.explanation) {
    body.append(el("p", "explanation", issue.explanation));
  } else {
    body.append(el("p", "explanation", "Không có giải thích."));
  }

  // Suggestion
  if (issue.suggestion) {
    const suggestionSection = el("div", "suggestion-section");
    
    const sugHeader = el("div", "suggestion-header");
    sugHeader.innerHTML = `<span>Đề xuất sửa</span>`;
    
    const copyBtn = el("button", "copy-btn");
    copyBtn.type = "button";
    copyBtn.innerHTML = `${COPY_ICON} <span>Sao chép</span>`;
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(issue.suggestion);
        copyBtn.innerHTML = `${CHECK_ICON} <span>Đã chép</span>`;
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.innerHTML = `${COPY_ICON} <span>Sao chép</span>`;
          copyBtn.classList.remove("copied");
        }, 1500);
      } catch {
        copyBtn.textContent = "Không chép được";
        setTimeout(() => {
          copyBtn.innerHTML = `${COPY_ICON} <span>Sao chép</span>`;
        }, 1500);
      }
    });
    sugHeader.append(copyBtn);
    
    const suggestionCode = el("pre", "suggestion-code", issue.suggestion);
    
    suggestionSection.append(sugHeader, suggestionCode);
    body.append(suggestionSection);
  }

  // Toggle handler
  header.addEventListener("click", () => {
    const isOpen = body.hidden;
    body.hidden = !isOpen;
    header.setAttribute("aria-expanded", isOpen);
    card.classList.toggle("open", isOpen);
  });

  // Keyboard support
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      header.click();
    }
  });

  card.append(header, body);
  return card;
}