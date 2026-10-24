# Bảng kiểm tra thủ công — Extension

| # | Kịch bản | Các bước | Kết quả mong đợi | Đạt/Không |
|---|----------|----------|------------------|-----------|
| 1 | Bôi đen code trên GitHub | Mở file Python trên GitHub → bôi đen đoạn code → click chuột phải → "Review với AI Code Reviewer" | Side panel mở, hiển thị "Đang phân tích..." → sau đó hiện danh sách lỗi, status "Hoàn tất (hybrid) · N lỗi" | |
| 2 | Chuột phải trên trang không có chữ bôi đen | Vào trang bất kỳ → không bôi đen gì → click chuột phải | Menu context **không** có mục "Review với AI Code Reviewer" | |
| 3 | Dán code thủ công | Mở side panel (nhấp biểu tượng extension) → dán code Python vào textarea → nhấn "Phân tích" hoặc `Ctrl+Enter` | Phân tích code vừa dán, hiển thị lỗi tương ứng | |
| 4 | Code rỗng | Xóa trắng textarea → nhấn "Phân tích" | Status: "Không có code để phân tích", không gọi API | |
| 5 | Code quá dài | Dán code > 20000 ký tự (hoặc sửa `max_code_length` nhỏ trong mock) → nhấn "Phân tích" | Status: "Code quá dài (X ký tự, giới hạn Y)", không gửi request | |
| 6 | Backend tắt (USE_MOCK=false) | Tắt server backend → bôi đen code → review | Status: "Backend: không kết nối", lỗi "Không kết nối được máy chủ" | |
| 7 | Chế độ LLM khi chưa có API key | Bật backend không có LLM_API_KEY → chọn chế độ "LLM" hoặc "Hybrid" → review | Hiện cảnh báo vàng: "LLM chưa cấu hình trên máy chủ, kết quả có thể chỉ có Bandit", status kèm "LLM gặp lỗi..." | |
| 8 | Bôi đen liên tiếp hai đoạn | Bôi đen đoạn 1 → review → đang "Đang phân tích..." → ngay lập tức bôi đen đoạn 2 → review | Request đoạn 1 bị huỷ, chỉ kết quả đoạn 2 hiển thị, không có lỗi "cancelled" hiện ra | |
| 9 | Lọc severity/confidence | Có danh sách lỗi → chọn dropdown "Mức nghiêm trọng" = High → chọn "Độ tin cậy" = Medium | Danh sách lọc client-side, không gọi lại API, summary cập nhật "Hiển thị X/Y lỗi" | |
| 10 | Sao chép đề xuất | Mở rộng thẻ lỗi có suggestion → nhấn nút "Sao chép" | Nội dung suggestion được copy vào clipboard, nút hiện "Đã chép" rồi quay lại "Sao chép" | |
| 11 | Mở bản đầy đủ trên Web | Nhấp link "Mở bản đầy đủ trên Web" ở side panel | Mở tab mới tại `LOCAL_URL` (http://localhost:8000) hoặc `DEPLOY_URL` | |
| 12 | Nhấp biểu tượng extension | Không bôi đen code, nhấp vào icon extension trên toolbar | Side panel mở, textarea trống, status "Hãy bôi đen code..." | |
| 13 | Chuyển chế độ review | Chọn "Bandit" → review → chọn "Hybrid" → review | Mỗi lần review dùng chế độ đang chọn, setting lưu lại (reload panel vẫn giữ chế độ) | |
| 14 | Hiển thị meta.mode trong status | Review xong với chế độ Hybrid | Status: "Hoàn tất (hybrid) · N lỗi" | |
| 15 | Hiển thị line number đúng (mock) | Bật USE_MOCK=true → review code mẫu | Các lỗi hiển thị đúng dòng: password=5, SQL=9, shell=14, chia 0=18, import=2 | |