const TYPES = ["security", "bug", "quality"];
const LEVELS = ["high", "medium", "low"];
const SOURCES = ["bandit", "llm", "both"];

const TYPE_LABEL = { security: "Security", bug: "Bug", quality: "Quality" };
const SOURCE_LABEL = { bandit: "Bandit", llm: "LLM", both: "Bandit + LLM" };
const SEVERITY_LABEL = { high: "Cao", medium: "Trung bình", low: "Thấp" };
const CONFIDENCE_LABEL = { high: "Tin cậy cao", medium: "Tin cậy vừa", low: "Tin cậy thấp" };
const LEVEL_ORDER = { high: 3, medium: 2, low: 1 };

const SVG_NS = "http://www.w3.org/2000/svg";

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

function svgPath(d) {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  return path;
}

export function makeIcon(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("empty-icon");

  const paths = {
    empty: [
      "M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z",
      "m9 12 2 2 4-4"
    ],
    none: [
      "M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z",
      "M9 12h6"
    ],
    error: [
      "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z",
      "M12 9v4",
      "M12 17h.01"
    ],
    warn: [
      "M12 9v4",
      "M12 17h.01",
      "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
    ]
  };

  (paths[kind] || paths.empty).forEach((d) => svg.append(svgPath(d)));
  return svg;
}

function badge(text, kind) {
  const node = el("span", `badge ${kind}`, text);
  node.prepend(el("span", "badge-dot"));
  return node;
}

function confidence(level) {
  const node = el("span", `conf ${level}`, null);
  node.title = CONFIDENCE_LABEL[level];
  for (let i = 0; i < 3; i += 1) node.append(el("span", "conf-dot"));
  node.append(el("span", "conf-label", CONFIDENCE_LABEL[level]));
  return node;
}

export function renderEmptyState(
  container,
  {
    title = "Không có kết quả",
    text = "",
    actionLabel = "",
    onAction = null,
    icon = "none"
  } = {}
) {
  container.replaceChildren();
  const wrap = el("div", "empty-state");
  wrap.append(makeIcon(icon));
  wrap.append(el("div", "empty-title", title));
  if (text) wrap.append(el("div", "empty-sub", text));

  if (actionLabel && onAction) {
    const button = el("button", "btn btn-primary", actionLabel);
    button.type = "button";
    button.addEventListener("click", onAction);
    wrap.append(button);
  }

  container.append(wrap);
}

function createCard(issue, index) {
  const type = TYPES.includes(issue.type) ? issue.type : "quality";
  const severity = LEVELS.includes(issue.severity) ? issue.severity : "low";
  const confidenceLevel = LEVELS.includes(issue.confidence) ? issue.confidence : "low";
  const source = SOURCES.includes(issue.source) ? issue.source : "bandit";

  const card = el("article", `issue-card type-${type}`, null);
  card.style.animationDelay = `${Math.min(index * 30, 240)}ms`;

  const toggle = el("button", "issue-card-toggle", null);
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.append(el("span", "issue-card-title", issue.message || "(không có tiêu đề)"));
  const icon = el("span", "expand-icon", "▼");
  icon.setAttribute("aria-hidden", "true");
  toggle.append(icon);

  const header = el("div", "issue-card-header", null);
  header.append(
    el("span", `issue-card-type type-${type}`, TYPE_LABEL[type]),
    badge(SEVERITY_LABEL[severity], `severity-${severity}`),
    confidence(confidenceLevel)
  );

  const meta = el("div", "issue-card-meta", `Dòng ${issue.line ?? "?"} · ${SOURCE_LABEL[source]}`);

  const details = el("div", "issue-card-details", null);
  if (issue.cwe_id) details.append(el("span", "cwe", issue.cwe_id));
  details.append(el("p", "explanation", issue.explanation || "Không có giải thích."));

  if (issue.suggestion) {
    const sugHead = el("div", "sug-head", null);
    sugHead.append(el("span", "sug-label", "Đề xuất sửa"));
    const copyBtn = el("button", "copy-btn", "Sao chép");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(issue.suggestion);
        copyBtn.textContent = "Đã chép";
      } catch {
        copyBtn.textContent = "Không chép được";
      }
      setTimeout(() => {
        copyBtn.textContent = "Sao chép";
      }, 1500);
    });
    sugHead.append(copyBtn);
    details.append(sugHead, el("pre", "code-block suggestion", issue.suggestion));
  }

  const setOpen = (open) => {
    details.classList.toggle("expanded", open);
    toggle.setAttribute("aria-expanded", String(open));
    icon.style.transform = open ? "rotate(180deg)" : "rotate(0deg)";
  };

  toggle.addEventListener("click", () => setOpen(!details.classList.contains("expanded")));

  card.addEventListener("click", (event) => {
    if (event.target.closest("button, a")) return;
    setOpen(!details.classList.contains("expanded"));
  });

  card.append(toggle, header, meta, details);
  return card;
}

export function showSkeleton(container, count = 3) {
  container.replaceChildren();
  for (let i = 0; i < count; i += 1) {
    const card = el("div", "issue-card", null);
    card.append(el("div", "skeleton", ""), el("div", "skeleton", ""), el("div", "skeleton", ""));
    const [a, b, c] = card.children;
    a.style.height = "16px";
    a.style.width = "70%";
    a.style.marginBottom = "10px";
    b.style.height = "12px";
    b.style.width = "45%";
    b.style.marginBottom = "10px";
    c.style.height = "40px";
    c.style.width = "100%";
    container.append(card);
  }
}

export function renderIssues(container, issues) {
  container.replaceChildren();
  if (issues.length === 0) {
    renderEmptyState(container, {
      text: "Thử đổi bộ lọc hoặc phân tích một đoạn code khác."
    });
    return;
  }
  issues.forEach((issue, index) => container.append(createCard(issue, index)));
}
