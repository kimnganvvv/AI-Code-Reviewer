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
      "source": "both"
    }
  ],
  "meta": {
    "mode": "hybrid",
    "bandit_count": 4,
    "llm_count": 6,
    "dropped_invalid_lines": 1,
    "merged_count": 2,
    "llm_error": null
  }
}
```

`meta.mode` phản ánh chế độ đã chạy: `bandit`, `llm`, `hybrid`, hoặc `mock`.
- `mode=bandit`: chỉ chạy Bandit, `llm_count = 0`, `llm_error = null`.
- `mode=llm`: chỉ chạy LLM, `bandit_count = 0`; nếu LLM chưa cấu hình thì `issues = []` và `llm_error` có thông báo.
- `mode=hybrid`: chạy cả hai; nếu LLM lỗi/chưa cấu hình thì vẫn trả kết quả Bandit kèm `llm_error`.

## 2. Cấu trúc `Issue` (10 trường bắt buộc)

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
| `source` | `string` | `bandit` \| `llm` \| `both` | Nguồn phát hiện. `both` = cả hai cùng xác nhận |

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

Khi cả Bandit và LLM phát hiện cùng 1 lỗi, nếu không gộp thì UI hiện 2 thẻ trùng nhau → user mất niềm tin. Quy tắc ghép (theo thứ tự ưu tiên):

1. **Khác nguồn** (Bandit vs LLM) — mới được gộp:
   - **Cùng `cwe_id` và lệch dòng ≤ 1** → cùng một lỗi.
   - **Trùng dòng + trùng `type`** (security/bug) → cùng một lỗi.
   - **Trùng dòng + ≥ 40% từ khóa chung** trong `message` → cùng một lỗi (fallback).
2. **Cùng nguồn** — chỉ gộp khi *thực sự là cùng một quy tắc* (cùng `test_id` của Bandit).
   → Nếu không có điều kiện này, `import subprocess` (B404) và `shell=True` (B602) ở cùng dòng 1 sẽ bị gộp nhầm thành 1 lỗi.

Khi gộp:
- `source` → `"both"` (chỉ nghĩa rõ ràng: cả 2 nguồn đều xác nhận → đáng tin hơn).
- Giữ **dòng của Bandit** (static analysis biết chính xác dòng nào).
- Giữ `explanation`/`message` **dài hơn** (LLM thường chi tiết hơn).
- `severity` lấy **cao hơn**; `confidence` lấy **cao hơn** (LLM đã kiểm chứng có context → đáng tin hơn cảnh báo thô).
