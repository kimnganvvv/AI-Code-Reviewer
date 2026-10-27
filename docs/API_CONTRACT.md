# Hợp đồng API v2

Tất cả thành viên dùng **cùng 1 hợp đồng**. Thay đổi chỉ được thực hiện tại `backend/app/schemas.py` và cần thông báo trước.

## 1. `POST /review`

### Request
```json
{
  "code": "import os\nprint(os.getcwd())",
  "filename": "snippet.py",
  "mode": "hybrid"
}
```

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `code` | `string` | có | Mã nguồn Python cần review |
| `filename` | `string` | không | Chỉ dùng hiển thị (mặc định `snippet.py`) |
| `mode` | `string` | không | `bandit` \| `tools` \| `llm` \| `filter` \| `hybrid` (mặc định `hybrid`) |

`mode` cũng nhận qua query: `POST /review?mode=bandit`. Nếu có cả hai, **query thắng body**.

### Response
```json
{
  "issues": [
    {
      "line": 3,
      "type": "security",
      "severity": "high",
      "confidence": "high",
      "cwe_id": "CWE-89",
      "message": "Possible SQL injection through string concatenation",
      "explanation": "Dữ liệu người dùng được nối trực tiếp vào câu SQL.",
      "suggestion": "conn.execute('SELECT * FROM users WHERE id = ?', (user_id,))",
      "source": "both",
      "end_line": 3
    }
  ],
  "meta": {
    "mode": "hybrid",
    "bandit_count": 4,
    "llm_count": 6,
    "dropped_invalid_lines": 1,
    "merged_count": 2,
    "llm_error": null,
    "suppressed_count": 1,
    "rejected_suggestions": 0
  }
}
```

`meta.mode` phản ánh chế độ đã chạy: `bandit`, `tools`, `llm`, `filter`, `hybrid`, hoặc `mock`.
- `mode=bandit`: chỉ chạy Bandit.
- `mode=tools`: chạy Bandit, Ruff và bộ phát hiện AST tự viết.
- `mode=llm`: chỉ chạy LLM độc lập; nếu LLM chưa cấu hình thì trả `issues = []` và ghi lý do trong `llm_error`.
- `mode=filter`: chạy công cụ tĩnh rồi dùng LLM thẩm định ứng viên.
- `mode=hybrid`: chạy công cụ tĩnh, LLM lọc ứng viên, rồi LLM tìm thêm một số lỗi ngoài phạm vi công cụ. Nếu LLM lỗi, trả các ứng viên công cụ theo chính sách fallback kèm `llm_error`.

Các khóa của `meta` (theo `ReviewMeta`):

| Trường | Kiểu | Mặc định | Mô tả |
|---|---|---|---|
| `mode` | `string` | — | `bandit` \| `tools` \| `llm` \| `filter` \| `hybrid` \| `mock` |
| `bandit_count` | `int` | `0` | Số ứng viên Bandit trước lọc |
| `ruff_count` | `int` | `0` | Số ứng viên Ruff |
| `static_count` | `int` | `0` | Số ứng viên từ bộ phát hiện AST tự viết |
| `candidate_count` | `int` | `0` | Số ứng viên sau khử trùng giữa các công cụ |
| `truncated_candidates` | `int` | `0` | Số ứng viên vượt giới hạn gửi lên LLM |
| `llm_count` | `int` | `0` | Số issue LLM tìm bổ sung ở tầng 3 hoặc mode `llm` |
| `dropped_invalid_lines` | `int` | `0` | Số issue bị loại bởi Line Validation/guardrail parse (dòng hoặc evidence không hợp lệ, trùng, vượt giới hạn...) |
| `merged_count` | `int` | `0` | Số lần gộp issue trùng |
| `llm_error` | `string` \| `null` | `null` | Lỗi/cấu hình LLM nếu có |
| `suppressed_count` | `int` | `0` | Số cảnh báo Bandit bị LLM loại là báo động giả |
| `rejected_suggestions` | `int` | `0` | Số bản vá bị loại do hỏng cú pháp hoặc no-op |
| `tool_warnings` | `string[]` | `[]` | Cảnh báo khi Ruff thiếu hoặc công cụ không phân tích được code |

## 2. Cấu trúc `Issue` (các trường mở rộng đều tuỳ chọn)

| Trường | Kiểu | Giá trị | Mô tả |
|---|---|---|---|
| `line` | `int` (>=1) | — | Số dòng lỗi, đã qua Line Validation |
| `type` | `string` | `security` \| `bug` \| `quality` | Nhóm lỗi |
| `severity` | `string` | `high` \| `medium` \| `low` | Mức độ nghiêm trọng |
| `confidence` | `string` | `high` \| `medium` \| `low` | Độ tin cậy đánh giá |
| `cwe_id` | `string` \| `null` | ví dụ `CWE-89` | Mã CWE (thường dùng với `security`) |
| `message` | `string` | — | Tiêu đề ngắn gọn |
| `explanation` | `string` | — | Nguyên nhân + luồng dữ liệu nguồn->đích |
| `suggestion` | `string` | — | Mã đề xuất sửa |
| `source` | `string` | `bandit` \| `ruff` \| `static` \| `llm` \| `both` | Nguồn phát hiện; `both` là ứng viên công cụ đã được LLM xác nhận |
| `end_line` | `int` \| `null` (>=1) | — | Dòng cuối mà `suggestion` thay thế (`line..end_line`). Tuỳ chọn; `null`/không có = dòng đơn `line` |
| `rule_id` | `string` \| `null` | ví dụ `B608`, `F401`, `NEST001`, `division_by_zero` | Mã rule công cụ hoặc category của tầng tìm lỗi thiếu |

## 3. Các endpoint khác

| Method | Path | Mô tả |
|---|---|---|
| `GET` | `/health` | `{"status":"ok","llm_enabled":bool,"max_code_length":int}` |
| `GET` | `/sample` | `{"code": "<mẫu Python>"}` |
| `POST` | `/mock/review` | Trả dữ liệu giả giống format thật, `meta.mode = "mock"`. Không cần API key. |

## 4. Lỗi

| HTTP | Khi nào | Ví dụ |
|---|---|---|
| `400` | Code rỗng | `{"detail": "Mã nguồn trống."}` |
| `413` | Vượt `MAX_CODE_LENGTH` | `{"detail": "Mã nguồn quá dài (... > ...) ký tự."}` |
| `500` | Lỗi nội bộ | `{"detail": "Lỗi nội bộ: ..."}` |
| `422` | Payload sai schema (kể cả `mode` không hợp lệ) | Lỗi validation của Pydantic |

## 5. Ghi chú tích hợp

- **Chrome Extension (Người 2)**: có thể gọi thẳng `POST /review`. Nếu chưa có key, dùng `mode=bandit`.
- **Prompt (Người 3)**: không được đổi 10 trường trên. Chỉ được thêm logic trong `prompts.py`.
- **Phát triển song song**: luôn dùng `/mock/review` khi chưa sẵn sàng cấu hình LLM. Giúp Người 2 làm Extension và Người 3 tinh chỉnh prompt mà không cần API key.
- **Đo 3 chế độ**: dùng cùng một bộ `samples/`, lần lượt gọi `mode=bandit`, `mode=llm`, `mode=hybrid` để tính Precision / Recall / F1 / FPR / Latency. Quan trọng: cùng một endpoint `/review?mode=...` có thể chạy 3 thí nghiệm mà không cần deploy lại.

### 5.1 Khử trùng lặp hiện tại

Pipeline hiện không có hàm `merge_duplicates()` để gộp danh sách Issue sau khi review. Có hai bước riêng:

1. **Candidate từ công cụ (tầng 1)**: `dedupe_candidates()` trong `backend/app/candidates.py` sắp xếp theo ưu tiên `bandit` → `ruff` → `static`. Cùng công cụ thì trùng khi `rule_id` và `line` giống nhau; khác công cụ thì trùng khi có cùng `cwe_id` khác `null` và lệch tối đa 1 dòng. Candidate ưu tiên cao hơn được giữ nguyên; candidate còn lại bị bỏ.
2. **Finding LLM tầng 3**: `drop_overlapping_gaps()` loại finding tầng 3 nếu cùng CWE và vùng dòng chồng/lân cận (dung sai 1 dòng) với bất kỳ candidate tầng 1 nào. Việc này áp dụng cả khi candidate đã bị LLM tầng 2 loại, để tầng 3 không đưa lại finding đó.

`apply_filter_verdicts()` chuyển verdict tầng 2 thành Issue; nó không gộp hai Issue theo `message`. Khi candidate được LLM xác nhận, `source` thành `both`; điều này có nghĩa công cụ tạo candidate và LLM tầng 2 cùng xác nhận. Finding tầng 3 có `source = llm`. Candidate không được gửi hoặc không nhận verdict được giữ theo chính sách fallback.

### 5.2 Suggestion và kiểm tra

`suggestion` luôn là chuỗi trong hợp đồng hiện tại; chuỗi rỗng biểu thị không có bản vá code trả về. Tầng lọc và tầng tìm lỗi thiếu kiểm tra cấu trúc phản hồi, dòng và bản vá theo từng parser. Ở tầng 3, evidence phải xuất hiện trong vùng code quanh finding; tầng 2 kiểm tra suggestion nếu có. Các kiểm tra này là guardrail định dạng/nội dung, không chứng minh finding đúng hoặc bản vá an toàn. API hiện tạo suggestion trong cùng request review; chưa có endpoint riêng để sinh suggestion theo nút bấm.
