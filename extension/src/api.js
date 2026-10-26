import { USE_MOCK, API_URL } from "./config.js";
import { LOCAL_URL, DEPLOY_URL } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let currentController = null;

function normalizeResponse(data) {
  if (Array.isArray(data)) {
    return { issues: data, meta: {} };
  }
  if (data && typeof data === "object" && "issues" in data) {
    return { issues: data.issues || [], meta: data.meta || {} };
  }
  return { issues: [], meta: {} };
}

function mapError(status) {
  if (status === 400) return "Mã nguồn trống hoặc không hợp lệ";
  if (status === 413) return "Code quá dài so với giới hạn của máy chủ";
  if (status === 422) return "Chế độ review không hợp lệ";
  if (status >= 500) return "Máy chủ gặp lỗi, thử lại sau";
  return `Lỗi HTTP ${status}`;
}

export function normalizeCode(code) {
  if (!code) return "";
  
  // Chỉ thay thế NBSP và zero-width space
  let normalized = code
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "");
  
  // Chuẩn hóa line endings
  normalized = normalized.replace(/\r\n/g, "\n");
  
  // Split lines, trim trailing whitespace per line
  const lines = normalized.split("\n").map(line => line.replace(/\s+$/, ""));
  
  // Trim leading/trailing empty lines
  let start = 0;
  while (start < lines.length && lines[start] === "") start++;
  let end = lines.length - 1;
  while (end >= 0 && lines[end] === "") end--;
  
  if (start > end) return "";
  
  const contentLines = lines.slice(start, end + 1);
  
  // Dedent: tìm phần thụt lề chung nhỏ nhất của TẤT CẢ dòng không rỗng
  const nonEmptyLines = contentLines.filter(line => line.trim().length > 0);
  if (nonEmptyLines.length > 0) {
    // Tìm số space nhỏ nhất ở đầu dòng của các dòng không rỗng
    let minIndent = Infinity;
    for (const line of nonEmptyLines) {
      const match = line.match(/^(\s*)/);
      if (match) {
        const indent = match[1].length;
        if (indent < minIndent) minIndent = indent;
      }
    }
    if (minIndent > 0 && minIndent !== Infinity) {
      // Bỏ phần thụt lề chung khỏi tất cả các dòng
      for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i].length >= minIndent) {
          contentLines[i] = contentLines[i].slice(minIndent);
        }
      }
    }
  }
  
  return contentLines.join("\n");
}

export function abortCurrentRequest() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
}

export async function reviewCode(code, { mode = "hybrid", signal } = {}) {
  if (currentController) {
    currentController.abort();
  }
  const controller = new AbortController();
  currentController = controller;

  // If external signal provided, abort when it aborts
  if (signal) {
    signal.addEventListener("abort", () => controller.abort());
  }

  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    if (USE_MOCK) {
      await sleep(600);
      const res = await fetch(chrome.runtime.getURL("src/mock-response.json"), { signal: controller.signal });
      if (!res.ok) throw new Error("Không đọc được mock-response.json");
      const data = await res.json();
      return normalizeResponse(data);
    }

    const url = new URL(API_URL);
    url.searchParams.set("mode", mode);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(mapError(res.status));
    }

    const data = await res.json();
    return normalizeResponse(data);
  } catch (err) {
    if (err.name === "AbortError" || err.name === "CancellationError") {
      throw new Error("cancelled");
    }
    if (err.message === "Failed to fetch" || err.name === "TypeError") {
      throw new Error("Không kết nối được máy chủ");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (currentController === controller) {
      currentController = null;
    }
  }
}

export async function getHealth() {
  try {
    const baseUrl = DEPLOY_URL || LOCAL_URL;
    const healthUrl = `${baseUrl}/health`;
    console.log("[AI Code Reviewer] Checking health at:", healthUrl);
    const res = await fetch(healthUrl, { method: "GET" });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("[AI Code Reviewer] Health check failed:", e);
    return null;
  }
}

export async function getSampleCode() {
  try {
    const baseUrl = DEPLOY_URL || LOCAL_URL;
    const res = await fetch(`${baseUrl}/sample`, { method: "GET" });
    if (!res.ok) return null;
    const data = await res.json();
    return data.code;
  } catch {
    return null;
  }
}