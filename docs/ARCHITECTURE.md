# Kiến trúc hệ thống

## 1. Tổng quan

AI Code Reviewer dùng mô hình **Single-pass Hybrid SAST + LLM**:
- **Bandit** phát hiện các lỗi bảo mật rõ ràng dựa trên luật.
- **LLM** trong **1 lượt gọi** vừa thẩm định cảnh báo Bandit (lọc false positive), vừa phát hiện lỗi Bandit bỏ sót.
- **Pipeline** lọc dòng ảo giác, gộp trùng và chuẩn hóa về cùng một hợp đồng JSON.

## 2. Luồng xử lý

```text
1. Đầu vào      -> POST /review { code, filename }
2. Kiểm tra     -> giới hạn độ dài, code không trống
3. Bandit SAST  -> chạy trên file tạm, parse JSON, map test_id -> CWE
4. LLM 1 lượt   -> nhúng bandit_findings + code vào prompt, yêu cầu thẩm định + bổ sung
5. Chuẩn hóa    -> sanitize_llm_issues (ép kiểu, lọc trường lạ)
6. Line Valid.  -> loại issue có line ngoài phạm vi file thực tế
7. Merge/Dedup  -> gộp Bandit+LLM -> source="both" nếu cùng lỗi
8. Sắp xếp      -> theo số dòng, sau đó theo severity
9. Trả về       -> { issues: [...10 trường...], meta: {...} }
```

## 3. Phân chia module (`backend/app/`)

| File | Trách nhiệm | Ghi chú |
|---|---|---|
| `main.py` | HTTP layer | Routes, CORS, phục vụ `web/`, xử lý lỗi |
| `schemas.py` | Hợp đồng | Pydantic models, `Literal` chặt chẽ. **Chỉ sửa tại đây khi đổi hợp đồng** |
| `config.py` | Cấu hình | Đọc `.env`, phát hiện LLM local (Ollama/LM Studio) |
| `bandit_runner.py` | SAST | `bandit -f json`, map CWE, gợi ý sửa nhanh |
| `llm_client.py` | LLM client | OpenAI-compatible, `extract_json_array`, bắt lỗi an toàn |
| `prompts.py` | Prompt | Thuộc Người 3. Backend chỉ dùng `SYSTEM_PROMPT` + `build_review_prompt()` |
| `pipeline.py` | Điều phối | Line Validation, Merge/Dedup, sanitize, review_code |
| `mock_data.py` | Mock + mẫu | `POST /mock/review`, code mẫu cho Web UI |

## 4. Web UI

- **2 cột đồng bộ**: CodeMirror bên trái, danh sách lỗi bên phải
- **Tương tác 2 chiều**: click thẻ lỗi -> cuộn + tô sáng dòng; click dòng code -> sáng thẻ lỗi tương ứng
- **Lọc client-side**: theo `type` / `severity` / `confidence` (không gọi lại API)
- **Màu theo nhóm**: Security đỏ, Bug cam, Quality xanh
- **Offline-friendly**: CodeMirror nằm trong `web/static/vendor/`

## 5. Bảo mật & hạn chế

**Đã áp dụng:**
- API key chỉ trong `.env` (đã có trong `.gitignore`)
- Giới hạn `MAX_CODE_LENGTH`, timeout cho Bandit/LLM
- Toàn bộ output LLM đều qua `sanitize` + `validate_lines`
- Chống prompt injection cơ bản bằng thẻ `<user_code>` (trong `prompts.py`)
- File tạm chạy Bandit dùng `TemporaryDirectory`, tự xóa

**Hạn chế (ghi nhận):**
- `CORS allow_origins=["*"]` — phù hợp demo, cần thu hẹp khi production
- Chưa có auth/rate-limit
- Chưa chặn tuyệt đối prompt injection phức tạp
