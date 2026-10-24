import { USE_MOCK, API_URL } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Trả về mảng lỗi theo hợp đồng JSON. Ném lỗi nếu thất bại.
export async function reviewCode(code) {
  if (USE_MOCK) {
    await sleep(600); // giả lập độ trễ để thấy trạng thái "đang phân tích"
    const res = await fetch(chrome.runtime.getURL("src/mock-response.json"));
    if (!res.ok) throw new Error("Không đọc được mock-response.json");
    return res.json();
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  if (!res.ok) throw new Error(`Backend trả về lỗi ${res.status}`);
  return res.json();
}