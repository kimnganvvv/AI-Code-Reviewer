// 1) Khi cài extension: tạo menu chuột phải (chỉ xuất hiện khi có chữ được bôi đen)
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "review-code",
    title: "Review với AI Code Reviewer",
    contexts: ["selection"]
  });
});

// 2) Khi người dùng bấm vào menu đó
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "review-code") return;

  // Mở khung bên phải NGAY (phải gọi ngay trong lúc xử lý click)
  chrome.sidePanel.open({ tabId: tab.id });

  // Lưu đoạn chữ bôi đen để side panel đọc
  chrome.storage.session.set({ pendingCode: info.selectionText });
});