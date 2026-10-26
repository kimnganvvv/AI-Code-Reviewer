const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

export function isGithubBlobUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      GITHUB_HOSTS.has(url.hostname) &&
      /^\/[^/]+\/[^/]+\/blob\/[^/]+\/.+/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function normalizeTabSize(value) {
  const size = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(size) && size >= 1 && size <= 16 ? String(size) : "";
}

export function isWholeFileSelection(selectionText, rawCode) {
  if (typeof selectionText !== "string" || typeof rawCode !== "string" || !rawCode) {
    return false;
  }

  const selection = selectionText.replace(/\r\n?/g, "\n");
  const file = rawCode.replace(/\r\n?/g, "\n");
  if (selection === file) return true;

  return file.endsWith("\n") && selection === file.slice(0, -1);
}

export function chooseGithubCode({ selectionText, extracted }) {
  const selection = typeof selectionText === "string" ? selectionText : "";
  const tabSize = normalizeTabSize(extracted?.tabSize);

  if (typeof extracted?.code !== "string") {
    return {
      code: selection,
      tabSize,
      notice:
        extracted?.error ||
        "Không đọc được nội dung file từ GitHub; đang dùng đoạn đã chọn."
    };
  }

  if (isWholeFileSelection(selection, extracted.code)) {
    return { code: extracted.code, tabSize, notice: "" };
  }

  return { code: selection, tabSize, notice: "" };
}

export async function extractGithubFileFromPage() {
  const rawLink =
    document.querySelector('a[data-testid="raw-button"]') ||
    Array.from(document.querySelectorAll("a")).find(
      (link) => link.textContent.trim() === "Raw" && link.href
    );

  if (!rawLink) {
    return { error: "Không tìm thấy nút Raw của GitHub." };
  }

  let response;
  try {
    response = await fetch(rawLink.href, {
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch {
    return { error: "Không tải được nội dung file từ GitHub." };
  }

  if (!response.ok) {
    return { error: `GitHub trả về HTTP ${response.status}.` };
  }

  let code;
  try {
    code = await response.text();
  } catch {
    return { error: "Không đọc được nội dung file từ GitHub." };
  }

  const codeNode =
    document.querySelector("textarea#read-only-cursor-text-area") ||
    document.querySelector(".react-file-line");
  const tabSize = codeNode ? getComputedStyle(codeNode).tabSize : "";

  return { code, tabSize };
}
