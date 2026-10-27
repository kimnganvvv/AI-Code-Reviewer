import {
  chooseGithubCode,
  extractGithubFileFromPage,
  isGithubBlobUrl
} from "./src/github.js";

async function setPendingSource({ code, notice = "", tabSize = "" }) {
  await chrome.storage.session.set({
    pendingCode: code,
    pendingCodeNotice: notice,
    pendingTabSize: tabSize
  });
}

/* Chuẩn hóa text bôi đen: về \n, đổi NBSP (U+00A0, hay gặp trong code đã tô màu cú pháp) thành khoảng trắng
   thường. Nếu không, Python báo SyntaxError dù code nhìn đúng. */
function normalizeSelection(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u200b\ufeff]/g, "");
}

function countLines(text) {
  const t = String(text || "").replace(/\n+$/, "");
  return t ? t.split("\n").length : 0;
}

/* Chạy TRONG trang: window.getSelection().toString() giữ xuống dòng giữa các khối (<pre>, <div> từng dòng,
   <tr>...), còn info.selectionText của menu chuột phải có thể gộp thành một dòng ở một số trang. */
function readPageSelection() {
  const sel = window.getSelection();
  return sel ? sel.toString() : "";
}

async function loadPageSelection(info, tab, selectionText) {
  const pageUrl = info.pageUrl || tab?.url || "";
  if (!tab?.id || isGithubBlobUrl(pageUrl)) return; // GitHub đã có luồng riêng bên dưới

  const target = { tabId: tab.id };
  if (Number.isInteger(info.frameId) && info.frameId >= 0) {
    target.frameIds = [info.frameId]; // vùng bôi đen nằm trong iframe nào thì đọc đúng iframe đó
  }

  let fromPage = "";
  try {
    const results = await chrome.scripting.executeScript({ target, func: readPageSelection });
    fromPage = normalizeSelection(results?.[0]?.result);
  } catch (err) {
    console.warn("Không đọc được vùng chọn từ trang, dùng selectionText:", err);
    return;
  }

  // Chỉ thay khi bản đọc từ trang thật sự giữ được nhiều dòng hơn; ngược lại giữ kết quả hiện có.
  if (fromPage.trim() && countLines(fromPage) > countLines(normalizeSelection(selectionText))) {
    await setPendingSource({ code: fromPage });
  }
}

async function loadGithubFile(info, tab, selectionText) {
  const pageUrl = info.pageUrl || tab?.url || "";
  if (!isGithubBlobUrl(pageUrl) || !tab?.id) return;

  let extracted;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractGithubFileFromPage
    });
    extracted = results?.[0]?.result;
  } catch (err) {
    extracted = {
      error: `Không đọc được file GitHub: ${err?.message || err}`
    };
  }

  await setPendingSource(chooseGithubCode({ selectionText, extracted }));
}

// 1) Khi cài extension: tạo menu chuột phải (chỉ xuất hiện khi có chữ được bôi đen)
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "review-code",
    title: "Review với AI Code Reviewer",
    contexts: ["selection"]
  });

  // Mở side panel khi nhấp vào biểu tượng extension
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    // API có thể không khả dụng trên một số phiên bản Chrome
    console.warn("setPanelBehavior not available:", e);
  }
});

// 2) Khi người dùng bấm vào menu đó
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "review-code" || !tab?.id) return;

  // Mở khung bên phải NGAY (phải gọi ngay trong lúc xử lý click)
  chrome.sidePanel.open({ tabId: tab.id });

  const selectionText =
    typeof info.selectionText === "string" ? info.selectionText : "";

  // Hiển thị ngay đoạn đã chọn (đã chuẩn hóa NBSP/xuống dòng).
  // Trang thường: đọc lại vùng chọn trực tiếp từ trang để không mất xuống dòng.
  // File GitHub: thay bằng nội dung file đầy đủ.
  void setPendingSource({ code: normalizeSelection(selectionText) });
  void loadPageSelection(info, tab, selectionText);
  void loadGithubFile(info, tab, selectionText);
});
