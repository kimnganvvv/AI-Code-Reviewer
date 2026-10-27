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
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "review-code") return;

  // Mở khung bên phải NGAY (phải gọi ngay trong lúc xử lý click)
  await chrome.sidePanel.open({ tabId: tab.id });

  // Lấy lựa chọn từ trang (giữ nguyên xuống dòng, thụt lề)
  let code = "";
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.getSelection().toString()
    });
    // Gộp kết quả từ các frame, chọn chuỗi không rỗng dài nhất
    const selections = results
      .map(r => r.result)
      .filter(s => typeof s === "string" && s.trim().length > 0);
    if (selections.length > 0) {
      code = selections.reduce((a, b) => a.length >= b.length ? a : b);
    }
  } catch (e) {
    console.warn("executeScript failed, fallback to info.selectionText:", e);
  }
  
  // Fallback nếu executeScript lỗi hoặc rỗng
  if (!code && info.selectionText) {
    code = info.selectionText;
  }

  // Lưu đoạn code để side panel đọc
  if (code) {
    await chrome.storage.session.set({ pendingCode: code });
  }
});