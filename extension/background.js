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

  // Hiển thị ngay đoạn đã chọn; nếu là file GitHub, thay bằng nội dung file đầy đủ.
  void setPendingSource({ code: selectionText });
  void loadGithubFile(info, tab, selectionText);
});
