# Hợp đồng API v2

Tất cả thành viên dùng **cùng 1 hợp đồng**. Thay đổi chỉ được thực hiện tại `backend/app/schemas.py` và cần thông báo trước.

## 1. `POST /review`

### Request
```json
{
  "code": "import os\nprint(os.getcwd())",
  "filename": "snippet.py"
}
```

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `code` | `string` | có | Mã nguồn Python cần review |
| `filename` | `string` | không | Chỉ dùng hiển thị (mặc định `snippet.py`) |

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
    "mode": "bandit+llm",
    "bandit_count": 4,
    "llm_count": 6,
    "dropped_invalid_lines": 1,
    "merged_count": 2,
    "llm_error": null
  }
}
```

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
| `422` | Payload sai schema | Lỗi validation của Pydantic |

## 5. Ghi chú tích hợp

- **Chrome Extension (Người 2)**: có thể gọi thẳng `POST /review`. Nếu chưa có key, vẫn hoạt động (Bandit-only).
- **Prompt (Người 3)**: không được đổi 10 trường trên. Chỉ được thêm logic trong `prompts.py`.
- **Phát triển song song**: luôn dùng `/mock/review` khi chưa sẵn sàng cấu hình LLM.
