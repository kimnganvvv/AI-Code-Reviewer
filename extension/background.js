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
  if (info.menuItemId !== "review-code") return;

  // Mở khung bên phải NGAY (phải gọi ngay trong lúc xử lý click)
  chrome.sidePanel.open({ tabId: tab.id });

  // Lưu đoạn chữ bôi đen để side panel đọc
  chrome.storage.session.set({ pendingCode: info.selectionText });
});