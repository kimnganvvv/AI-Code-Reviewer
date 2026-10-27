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
| `mode` | `string` | không | `bandit` \| `llm` \| `hybrid` (mặc định `hybrid`) |

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

`meta.mode` phản ánh chế độ đã chạy: `bandit`, `llm`, `hybrid`, hoặc `mock`.
- `mode=bandit`: chỉ chạy Bandit, `llm_count = 0`, `llm_error = null`.
- `mode=llm`: chỉ chạy LLM, `bandit_count = 0`; nếu LLM chưa cấu hình thì `issues = []` và `llm_error` có thông báo.
- `mode=hybrid`: chạy cả hai; nếu LLM lỗi/chưa cấu hình thì vẫn trả kết quả Bandit kèm `llm_error`.

Các khóa của `meta` (theo `ReviewMeta`):

| Trường | Kiểu | Mặc định | Mô tả |
|---|---|---|---|
| `mode` | `string` | — | `bandit` \| `llm` \| `hybrid` \| `mock` |
| `bandit_count` | `int` | `0` | Số cảnh báo Bandit ban đầu, trước phán quyết của LLM |
| `llm_count` | `int` | `0` | Số `new_issue` mới do LLM trả về (không tính `bandit_verdicts`) |
| `dropped_invalid_lines` | `int` | `0` | Số issue bị loại bởi Line Validation/guardrail parse (dòng hoặc evidence không hợp lệ, trùng, vượt giới hạn...) |
| `merged_count` | `int` | `0` | Số lần gộp issue trùng |
| `llm_error` | `string` \| `null` | `null` | Lỗi/cấu hình LLM nếu có |
| `suppressed_count` | `int` | `0` | Số cảnh báo Bandit bị LLM loại là báo động giả |
| `rejected_suggestions` | `int` | `0` | Số bản vá bị loại do hỏng cú pháp hoặc no-op |

## 2. Cấu trúc `Issue` (10 trường; `end_line` tuỳ chọn)

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
| `source` | `string` | `bandit` \| `llm` \| `both` | Nguồn phát hiện. `both` được đặt khi LLM xác nhận cảnh báo Bandit hoặc khi gộp issue; pipeline hiện tại cũng đặt `both` khi gộp cùng nguồn (LLM–LLM, Bandit–Bandit), nên không dùng `both` để suy ra chắc chắn có đủ hai nguồn |
| `end_line` | `int` \| `null` (>=1) | — | Dòng cuối mà `suggestion` thay thế (`line..end_line`). Tuỳ chọn; `null`/không có = dòng đơn `line` |

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

### 5.1 Quy tắc gộp trùng (Merge/Dedup)

`merge_duplicates()` là heuristic (không phải bằng chứng chắc chắn hai issue là cùng một lỗi). Quy tắc ghép:

1. **Bandit–Bandit**: chỉ gộp khi cùng `test_id` và cùng `line`.
   → Nếu không có điều kiện này, `import subprocess` (B404) và `shell=True` (B602) ở cùng dòng sẽ bị gộp nhầm.
2. **LLM–LLM**: chỉ gộp khi cả hai có **cùng `cwe_id` khác `null`** và **cùng `line`**.
   → Không dùng fallback theo `type`/`message`; thiếu `cwe_id` hoặc lệch dòng thì giữ riêng.
3. **Nguồn mới chưa có trong issue đích** (thường là Bandit–LLM):
   - **Cùng `cwe_id` khác `null` và lệch dòng ≤ 1** → cùng một lỗi.
   - **Trùng dòng + trùng `type`** (`security`/`bug`) → cùng một lỗi.
   - **Trùng dòng + ≥ 40% từ khóa chung** trong `message` → cùng một lỗi (fallback).

Khi gộp:
- `source` → `"both"` cho **mọi** lần gộp, kể cả LLM–LLM và Bandit–Bandit. Ngoài ra `apply_bandit_verdicts()` cũng đặt `both` khi LLM giữ một cảnh báo Bandit. Vì vậy `both` **không** đảm bảo có đủ hai nguồn; với LLM–LLM, `both` không có nghĩa Bandit cũng xác nhận.
- Giữ **dòng của issue đích** (issue đứng trước). Pipeline xếp Bandit trước LLM nên gộp Bandit–LLM thường giữ dòng Bandit.
- Giữ `explanation`/`message` **dài hơn** (LLM thường chi tiết hơn).
- `severity` lấy **cao hơn**; `confidence` lấy **cao hơn** (LLM đã kiểm chứng có context → đáng tin hơn cảnh báo thô).
