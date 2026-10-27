import { USE_MOCK, API_URL } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Phải lớn hơn LLM_TIMEOUT của backend (hybrid có thể gọi LLM 2 lần), khớp Web UI. */
const REQUEST_TIMEOUT_MS = 330000;

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

export async function reviewCode(code, { mode = "hybrid", signal } = {}) {
  if (currentController) {
    currentController.abort();
  }
  const controller = new AbortController();
  currentController = controller;

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

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
      if (timedOut) throw new Error("Máy chủ phản hồi quá lâu, thử lại sau");
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

export function cancelReview() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
}

export async function getHealth() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const baseUrl = API_URL.replace(/\/review\/?$/, "");
    const res = await fetch(`${baseUrl}/health`, {
      method: "GET",
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}