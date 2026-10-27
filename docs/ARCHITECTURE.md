# Kiến trúc hệ thống

## 1. Tổng quan

AI Code Reviewer dùng pipeline ba tầng:

1. **Công cụ tĩnh**: Bandit tìm vấn đề bảo mật; Ruff tìm bug/quality; bộ AST tự viết bắt độ lồng sâu và hàm trùng cấu trúc.
2. **LLM lọc ứng viên**: một lời gọi theo lô để giữ/bỏ ứng viên công cụ và đề xuất sửa.
3. **LLM tìm lỗi còn thiếu**: tìm một số lỗi thuộc nhóm công cụ chưa bao phủ; bằng chứng và dòng được kiểm tra lại bằng code.

`hybrid` chạy cả ba tầng. Các mode `bandit`, `tools`, `llm`, `filter` cho phép chạy từng phần để so sánh. Tầng 2 và tầng 3 là hai lời gọi riêng; mỗi tầng có thể retry theo cấu hình.

## 2. Luồng xử lý

```text
POST /review { code, filename, mode }
  -> kiểm tra code rỗng và giới hạn độ dài
  -> mode=bandit: Bandit
     mode=tools/filter/hybrid: Bandit + Ruff + bộ phát hiện AST
  -> mode=filter/hybrid: khử trùng, xếp ưu tiên, gửi ứng viên cho LLM lọc
  -> mode=hybrid: LLM tìm lỗi ngoài phạm vi công cụ
  -> parser/guardrail theo từng tầng, kiểm tra dòng cuối và sắp xếp findings
  -> { issues: [...], meta: {...} }
```

### Các chế độ (`mode` trong body hoặc query `?mode=...`)

| `mode` | Hành vi |
|---|---|
| `bandit` | Chỉ Bandit; baseline SAST |
| `tools` | Bandit + Ruff + static, không gọi LLM |
| `llm` | LLM phân tích độc lập, không chạy công cụ |
| `filter` | Công cụ tĩnh + LLM lọc ứng viên |
| `hybrid` | Công cụ tĩnh + LLM lọc + LLM tìm lỗi còn thiếu |

Nếu LLM chưa cấu hình, `llm` trả danh sách rỗng kèm `meta.llm_error`; `filter` và `hybrid` giữ ứng viên công cụ theo chính sách fallback. `tools` và `bandit` không cần LLM.

## 3. Phân chia module (`backend/app/`)

| File | Trách nhiệm | Ghi chú |
|---|---|---|
| `main.py` | HTTP layer | Routes, CORS, phục vụ Web UI (`/` → `index.html`, `/sample`, `/health), xử lý lỗi HTTP. Bật CORS `allow_origins=["*"]` để Chrome Extension gọi cross-origin. |
| `schemas.py` | Hợp đồng | Pydantic models cho 5 mode review và nguồn Bandit/Ruff/static/LLM. |
| `config.py` | Cấu hình | Đọc `.env`, giới hạn và cấu hình cho công cụ tĩnh, LLM lọc và LLM tìm lỗi thiếu. |
| `bandit_runner.py`, `ruff_runner.py` | Công cụ tĩnh | Chạy Bandit/Ruff trong thư mục tạm, chuẩn hóa findings. |
| `static_detectors.py` | Công cụ tĩnh | Dùng AST phát hiện nesting sâu và hàm trùng cấu trúc. |
| `candidates.py` | Ứng viên | Chuẩn hóa, khử trùng, xếp ưu tiên và áp phán quyết tầng lọc. |
| `layered_prompts.py` | Prompt 3 tầng | Tạo prompt và parser có kiểm tra cho tầng lọc/tìm lỗi thiếu. |
| `prompts.py` | Prompt tương thích | Prompt/parser cũ dùng cho mode `llm` và helper chia sẻ. |
| `llm_client.py` | LLM client | Gọi endpoint OpenAI-compatible, retry JSON/rate limit, cung cấp entry point cho từng tầng. |
| `pipeline.py` | Điều phối | Chạy các mode, fallback khi LLM lỗi, kiểm tra dòng cuối và sắp xếp findings. |
| `mock_data.py` | Mock + mẫu | `POST /mock/review` trả dữ liệu giả đồng nhất format thật. **Quan trọng nhất về teamwork**: Giúp Người 2 làm Extension ngay tuần 1 (không cần API key) và Người 3 tinh chỉnh prompt mà không cần chạy hết pipeline. "Làm mất khoảng 1 buổi, cứu cả nhóm." |

## 4. Web UI

- **2 cột đồng bộ**: CodeMirror (bên trái) hiển thị code Python, danh sách findings (bên phải)
- **Tương tác 2 chiều**:
  * Click thẻ lỗi → CodeMirror `addLineClass()` + `scrollIntoView()` → cuộn code đến dòng lỗi
  * Click dòng code → sự kiện `cursorActivity` của CodeMirror → tìm issue có line khớp → thêm class `active` vào card tương ứng, `scrollIntoView`
- **Lọc client-side**: Theo `type` / `severity` / `confidence` trên mảng `allIssues` đã có — **không gọi lại API**, phản hồi tức thì
- **Màu theo nhóm**: Security đỏ (`--security: #f87171`), Bug cam (`--bug: #fbbf24`), Quality xanh lá (`--quality: #34d399`). Màu hiển thị bằng viền trái 3px của thẻ lỗi — nhìn nhanh, không cần đọc chữ
- **Offline-friendly**: CodeMirror và CSS nằm trong `web/static/vendor/` — demo hoạt động ngay không cần cài Node/Vite/npm
- **Tối ưu UX**: Empty state có illustration + hướng dẫn, thanh công cụ dễ sử dụng, badge trạng thái LLM rõ ràng (on/off). Toolbar sắp xếp: nút (Run/Mock/Sample) + chế độ chọn + bộ lọc theo loại/độ tin cậy/severity + nút Reset filter.
- **Responsive**: Trên màn hình lớn (>= 1024px) là 2 cột ngang; nhỏ hơn chuyển thành 1 cột full-width, `#issues` max-height 60vh, toolbar ngang 100%.

## 5. Bảo mật & hạn chế

**Đã áp dụng:**
- API key chỉ trong `.env`, `.env` đã có trong `.gitignore` → jamais committed vào repo
- Giới hạn `MAX_CODE_LENGTH = 20000` ký tự → chặn payload quá lớn (HTTP 413)
- `timeout` cho Bandit (30s) và LLM (90s) → không treo server, tự động terminate
- Output LLM được parser theo tầng kiểm tra schema/field, dòng, evidence (tầng 3), suggestion nếu có và điều kiện riêng; pipeline tiếp tục kiểm tra dòng issue trước khi trả response. Đây là guardrail, không chứng minh finding hay bản vá đúng.
- Code người dùng được bọc thẻ `<user_code>` trong Prompt (chống prompt injection cơ bản — do Người 3 thiết kế nhưng Backend là nơi áp dụng)
- File tạm chạy Bandit dùng `TemporaryDirectory` (context manager), tự xóa sau khi hoàn thành

**Hạn chế (ghi nhận, cần nói thẳng khi bảo vệ):**
- `CORS allow_origins=["*"]` — phù hợp demo, cần thu hẹp danh sách domain khi deploy sản phẩm thật (ví dụ chỉ cho phép extension Chrome và domain chính)
- Chưa có auth/rate-limit → sản phẩm cần giới hạn số lượt/người dùng để bảo vệ quota LLM và tránh lạm dụng
- Code người dùng được ghi ra file tạm để chạy Bandit → đã tự xóa bằng `TemporaryDirectory`, nhưng cần lưu ý về an toàn file tạm trên shared hosting
- Chưa chặn tuyệt đối prompt injection phức tạp → với sản phẩm thật nên có thêm层 lớp validate input, allowlist domain, và rate limiting theo quota API key
