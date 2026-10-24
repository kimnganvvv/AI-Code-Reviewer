# Kiến trúc hệ thống

## 1. Tổng quan

AI Code Reviewer implements a **Single-pass Hybrid SAST + LLM** architecture:

- **Bandit (SAST)**: Phát hiện các lỗi bảo mật rõ ràng dựa trên các quy tắc cứng (regex/AST). Chạy offline, không cần API key.
- **LLM (Large Language Model)**: Thẩm định và bổ sung. Trong **1 lượt gọi** duy nhất, LLM vừa thẩm định lại cảnh báo từ Bandit (lọc false positive), vừa phát hiện lỗi mà Bandit bỏ sót (bugs, quality issues).
- **Pipeline**: Xử lý luồng dữ liệu từ đầu vào đến đầu ra: chuẩn hóa, validation dòng, gộp trùng, sắp xếp, và trả về JSON hợp đồng thống nhất.

**Ưu điểm chính**: Giảm ~50% chi phí token và độ trễ so với cách gọi LLM 2 lượt.

## 2. Luồng xử lý

```text
1. Đầu vào      -> POST /review { code, filename, mode }
                   mode = bandit | llm | hybrid (mặc định hybrid)
2. Kiểm tra     -> giới hạn độ dài, code không trống
3. Bandit SAST  -> chạy khi mode = bandit | hybrid
                   (file tạm, parse JSON, map test_id -> CWE)
4. LLM 1 lượt   -> chạy khi mode = llm | hybrid
                   (nhúng bandit_findings + code, thẩm định + bổ sung)
5. Chuẩn hóa    -> sanitize_llm_issues (ép kiểu, lọc trường lạ)
6. Line Valid.  -> loại issue có line ngoài phạm vi file thực tế
7. Merge/Dedup  -> gộp Bandit+LLM -> source="both" nếu cùng lỗi
8. Sắp xếp      -> theo số dòng, sau đó theo severity
9. Trả về       -> { issues: [...10 trường...], meta: {mode, ...} }
```

### 3 chế độ đo (`mode` trong body hoặc query `?mode=...`)

| `mode` | Bandit | LLM | Mục đích |
|---|---|---|---|
| `bandit` | ✅ | ❌ | Baseline SAST, không tốn token, không cần API key |
| `llm` | ❌ | ✅ | Đo khả năng thuần LLM trong việc tìm bug/quality |
| `hybrid` | ✅ | ✅ | Chế độ sản phẩm: thẩm định false positive Bandit |

**Quan trọng**: `meta.mode` luôn echo lại chính xác chế độ đã yêu cầu, giúp script đo tách kết quả đúng. Nếu LLM chưa cấu hình:
- `hybrid`: Vẫn trả kết quả Bandit + `meta.llm_error` ghi lý do fallback.
- `llm`: Trả `issues=[]` + `meta.llm_error`.

## 3. Phân chia module (`backend/app/`)

| File | Trách nhiệm | Ghi chú |
|---|---|---|
| `main.py` | HTTP layer | Routes, CORS, phục vụ Web UI (`/` → `index.html`, `/sample`, `/health), xử lý lỗi HTTP. Bật CORS `allow_origins=["*"]` để Chrome Extension gọi cross-origin. |
| `schemas.py` | Hợp đồng | Pydantic models với `Literal` chặt chẽ cho `type` (security/bug/quality), `severity` (high/medium/low), `confidence` (high/medium/low), `source` (bandit/llm/both). **Chỉ sửa tại đây khi thay đổi hợp đồng API** — cần thông báo cho toàn nhóm trước. Dùng `Literal` vì nếu gửi `type: "critical"` thì Pydantic tự báo lỗi thay vì âm thầm lọt vào hệ thống. |
| `config.py` | Cấu hình | Đọc `.env` qua `load_dotenv()`. Phát hiện LLM local: nếu có `LLM_API_KEY` → cloud (OpenAI, OpenRouter, v.v.); nếu không key nhưng `LLM_BASE_URL` trỏ về `localhost` → dùng Ollama/LM Studio miễn phí. Hàm `llm_is_configured()` xử lý 2 trường hợp này. |
| `bandit_runner.py` | SAST | Chạy `bandit -f json` qua subprocess với cờ `--confidence-level all` (lấy cả cảnh báo yếu vì LLM sẽ thẩm định). Ánh xạ `test_id` → `CWE` qua `BANDIT_CWE_MAP`. Cung cấp `BANDIT_FIXES` để Web UI hiện suggestions ngay cả khi LLM chưa chạy. **Vì sao CLI chứ không dùng Python API?** Dễ debug (chạy `bandit -f json` trực tiếp trong terminal) và tách bạch phiên bản. |
| `llm_client.py` | LLM client | Gọi OpenAI-compatible endpoint (`/chat/completions`). Hàm `extract_json_array()` bóc JSON từ output LLM: xóa code fence, cắt từ `[` đầu đến `]` cuối, thử parse; nếu lỗi → xoá dấu phẩy thừa rồi parse lại. **Luật cấm**: LLM có thể trả rác → mọi output đều đi qua `try/except` → lỗi đưa vào `meta.llm_error`, hệ thống vẫn trả kết quả Bandit (không crash). |
| `prompts.py` | Prompt | **Thuộc Người 3**. Backend chỉ chạm 2 điểm móc: `from . import prompts` và `llm_review(code, bandit_issues, prompts.SYSTEM_PROMPT, prompts.build_review_prompt)`. Ranh giới trách nhiệm rõ: Người 3 sửa `prompts.py`, Người 1 sửa code liên quan. Bản baseline có: Grounding Constraint, chống Prompt Injection (thẻ `<user_code>`), CWE Micro-Rubrics, ràng buộc "trả về 1 mảng JSON, không lời mở đầu, không markdown". |
| `pipeline.py` | Điều phối (tim/core) | Ba bài toán cốt lõi: (a) **Line Validation** — chống ảo giác số dòng (LLM có 31.8% lỗi fact về dòng). (b) **Merge/Dedup** — gộp Bandit+LLM tránh hiện 2 thẻ trùng lẻ. (c) `sanitize_llm_issues()` — ép LLM về hợp đồng (type lạ → quality, severity lạ → medium, line không parse → 0). Hàm `review_code()` orchestrating toàn bộ luồng từ đầu vào đến trả về JSON. |
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
- Toàn bộ output LLM đều qua `sanitize_llm_issues()` + `validate_lines()` trước khi ra ngoài
- Code người dùng được bọc thẻ `<user_code>` trong Prompt (chống prompt injection cơ bản — do Người 3 thiết kế nhưng Backend là nơi áp dụng)
- File tạm chạy Bandit dùng `TemporaryDirectory` (context manager), tự xóa sau khi hoàn thành

**Hạn chế (ghi nhận, cần nói thẳng khi bảo vệ):**
- `CORS allow_origins=["*"]` — phù hợp demo, cần thu hẹp danh sách domain khi deploy sản phẩm thật (ví dụ chỉ cho phép extension Chrome và domain chính)
- Chưa có auth/rate-limit → sản phẩm cần giới hạn số lượt/người dùng để bảo vệ quota LLM và tránh lạm dụng
- Code người dùng được ghi ra file tạm để chạy Bandit → đã tự xóa bằng `TemporaryDirectory`, nhưng cần lưu ý về an toàn file tạm trên shared hosting
- Chưa chặn tuyệt đối prompt injection phức tạp → với sản phẩm thật nên có thêm层 lớp validate input, allowlist domain, và rate limiting theo quota API key
