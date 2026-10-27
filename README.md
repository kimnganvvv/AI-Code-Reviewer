# AI Code Reviewer

Ứng dụng review mã Python kết hợp **Bandit**, **Ruff**, bộ phát hiện tĩnh dựa trên AST và LLM. Repository gồm backend FastAPI, Web UI tĩnh, Chrome Extension Manifest V3 và benchmark để đo precision/recall trên bộ mẫu có nhãn.

> Đây là công cụ hỗ trợ phân tích, không thay thế review hoặc kiểm thử của lập trình viên. Finding và suggestion có thể sai; hãy xem lại trước khi áp dụng. Nếu dùng LLM cloud, code được gửi đến nhà cung cấp đã cấu hình.

## Mục lục

- [Kiến trúc và luồng review](#kiến-trúc-và-luồng-review)
- [Các chế độ review](#các-chế-độ-review)
- [Cấu trúc repository](#cấu-trúc-repository)
- [Cài đặt và chạy backend](#cài-đặt-và-chạy-backend)
- [Cấu hình LLM và Ollama](#cấu-hình-llm-và-ollama)
- [API](#api)
- [Web UI](#web-ui)
- [Chrome Extension](#chrome-extension)
- [Benchmark](#benchmark)
- [Kiểm thử và lint](#kiểm-thử-và-lint)
- [Triển khai và giới hạn bảo mật](#triển-khai-và-giới-hạn-bảo-mật)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Báo lỗi và thảo luận](#báo-lỗi-và-thảo-luận)
- [Giấy phép](#giấy-phép)

## Kiến trúc và luồng review

```text
Web UI / Chrome Extension / benchmark client
                     |
                     v
              FastAPI POST /review
                     |
      Tầng 1: Bandit + Ruff + AST detectors
                     |
      Tầng 2: LLM thẩm định ứng viên công cụ
                     |
      Tầng 3: LLM tìm một số lỗi ngoài phạm vi công cụ
                     |
      kiểm tra dòng, bằng chứng, suggestion, trùng lặp
                     v
             { issues: [...], meta: {...} }
```

### Tầng 1: công cụ tĩnh

- **Bandit** phát hiện các mẫu rủi ro bảo mật Python.
- **Ruff** phát hiện một số lỗi và vấn đề chất lượng. Cấu hình mặc định chọn nhóm `F`, `B`, `SIM`, `C901` và một số rule `PLR`; không bật nhóm Ruff `S` để tránh lặp phần lớn Bandit.
- **AST detectors** bổ sung các mẫu như độ lồng sâu, hàm/khối lệnh trùng, data leakage khi chia train/test, một số lỗi Django, off-by-one/bỏ phần dư batch, SQL/path taint đơn giản, chia có thể cho 0, IDOR và race condition trên ORM.

Các finding được chuẩn hóa thành candidate rồi khử trùng. Finding cùng tool được so theo rule và dòng; giữa các tool, finding cùng CWE và gần nhau tối đa một dòng có thể được gộp. Đây là heuristic, không khẳng định chắc chắn hai finding là cùng một lỗi.

### Tầng 2: LLM lọc candidate

Một request theo lô yêu cầu LLM giữ hoặc loại từng candidate và có thể đề xuất bản vá. Candidate thiếu verdict được giữ mặc định để tránh LLM bỏ sót cảnh báo. Candidate vượt giới hạn gửi LLM được xử lý theo chính sách fallback. Khi tầng này lỗi, backend trả candidate công cụ phù hợp cùng `meta.llm_error`; ở `hybrid`, tầng 3 được bỏ qua nếu tầng 2 lỗi.

### Tầng 3: tìm lỗi còn thiếu

Trong `hybrid`, một request LLM riêng tìm thêm tối đa `GAP_MAX_ISSUES` finding thuộc **bốn nhóm**: chia cho 0, race condition, lộ dữ liệu nhạy cảm và IDOR. Tầng này không phải review tổng quát; các nhóm ngoài phạm vi được để cho công cụ hoặc tầng khác.

### Kiểm tra kết quả

Backend xác thực dòng trong phạm vi code; tầng tìm lỗi còn thiếu còn phải cung cấp `evidence` khớp với đoạn code. Finding trùng với candidate công cụ có thể bị loại. Suggestion được kiểm tra phạm vi dòng, no-op và cú pháp khi snippet gốc parse được. Việc kiểm tra cú pháp không chứng minh bản vá đúng nghiệp vụ hoặc đã loại bỏ lỗ hổng.

Trong `hybrid`, tầng lọc và tầng tìm lỗi thiếu là hai lời gọi LLM riêng. Client có retry khi JSON lỗi; có thể retry kết nối/HTTP 429 theo cấu hình. Do đó thời gian và số request thực tế phụ thuộc model, provider và retry.

## Các chế độ review

| `mode` | Các bước chạy | Cần LLM |
|---|---|:---:|
| `bandit` | Chỉ Bandit | Không |
| `tools` | Bandit + Ruff + AST detectors | Không |
| `llm` | LLM review độc lập, không chạy công cụ; dùng làm baseline | Có |
| `filter` | Tầng 1 rồi LLM lọc candidate | Có |
| `hybrid` | Tầng 1 + LLM lọc + LLM tìm lỗi còn thiếu; mặc định | Có |

Nếu LLM chưa cấu hình, `bandit` và `tools` vẫn chạy bình thường. `filter`/`hybrid` trả finding từ công cụ theo fallback và ghi nguyên nhân trong `meta.llm_error`. `llm` trả `issues: []` cùng `meta.llm_error` nếu LLM không sẵn sàng.

## Cấu trúc repository

```text
backend/
  app/
    main.py              # FastAPI routes, CORS và static web
    schemas.py           # Request/response Pydantic contract
    config.py            # Đọc backend/.env và cấu hình runtime
    bandit_runner.py     # Chạy Bandit, chuẩn hóa findings
    ruff_runner.py       # Chạy Ruff, chuẩn hóa findings
    static_detectors.py  # AST detectors tự viết
    candidates.py        # Gộp, xếp hạng và lọc candidate
    layered_prompts.py   # Prompt/parser cho tầng 2 và 3
    prompts.py           # Prompt/parser tương thích, mode llm và helper
    llm_client.py        # OpenAI-compatible client, timeout và retry
    pipeline.py          # Điều phối mode và fallback
    mock_data.py         # Dữ liệu cho /sample và /mock/review
  tests/                 # API contract và pipeline tests
  web/                   # Web UI và vendor assets
benchmark/
  samples/               # Python samples và labels.json
  src/                   # API client, matching, metrics, report
  scripts/               # Chạy benchmark và tạo biểu đồ
  tests/                 # Unit tests benchmark
extension/
  manifest.json          # Chrome Manifest V3
  background.js          # Context menu và nhận code được chọn
  src/                   # API client, GitHub source, render, config, storage
  sidepanel/             # Giao diện và logic extension
  tests/                 # Playwright tests (cần cài Playwright/browser)
docs/
  API_CONTRACT.md        # Hợp đồng API chi tiết
  ARCHITECTURE.md        # Ghi chú kiến trúc
```

## Cài đặt và chạy backend

Yêu cầu Python **3.10 trở lên**. Từ thư mục gốc repository, tạo môi trường và cài dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

Chạy server:

```powershell
python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Mặc định Web UI, Swagger và health check ở:

- Web UI: <http://127.0.0.1:8000/>
- Swagger: <http://127.0.0.1:8000/docs>
- Health: <http://127.0.0.1:8000/health>

Backend không cần `.env` để chạy `bandit` hoặc `tools`. Để cấu hình LLM local, tạo file từ mẫu:

```powershell
Copy-Item .\backend\.env.example .\backend\.env
```

Sau khi sửa `.env`, cần khởi động lại backend để nạp giá trị mới. Không commit `backend/.env` hoặc API key.

## Cấu hình LLM và Ollama

Backend gọi endpoint OpenAI-compatible tại `LLM_BASE_URL/chat/completions`. `backend/.env.example` hiện là cấu hình mẫu cho Ollama local:

```ini
USE_LLM=1
LLM_API_KEY=
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen2.5-coder:3b
LLM_TEMPERATURE=0
LLM_TIMEOUT=300
LLM_STRUCTURED_OUTPUT=json_object
```

Đảm bảo Ollama đang chạy và đã tải đúng model. Ví dụ:

```powershell
ollama pull qwen2.5-coder:3b
```

Sau đó chạy backend như phần trên. Với Ollama local có thể để `LLM_API_KEY` trống. Backend coi LLM local là đã cấu hình nếu `USE_LLM=1` và URL chứa `localhost` hoặc `127.0.0.1`; điều đó **không xác nhận** Ollama/model đang chạy hoặc request sẽ thành công.

Các biến trong `backend/.env.example`:

| Biến | Giá trị mẫu | Ý nghĩa |
|---|---:|---|
| `USE_LLM` | `1` | Bật/tắt các mode cần LLM. |
| `LLM_API_KEY` | rỗng | API key provider; Ollama local thường không cần. |
| `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | Base URL OpenAI-compatible. |
| `LLM_MODEL` | `qwen2.5-coder:3b` | Model đã có trên provider. |
| `LLM_TEMPERATURE` | `0` | Temperature gửi trong request. |
| `LLM_TIMEOUT` | `300` giây | Timeout cho mỗi request LLM. |
| `LLM_PARSE_RETRIES` | `1` | Số lần gọi lại khi JSON không parse được; tổng lượt tối đa là 1 + giá trị này. |
| `LLM_STRUCTURED_OUTPUT` | `json_object` | Chế độ JSON output: `off`, `json_object` hoặc `json_schema`. Nếu provider từ chối `response_format`, client thử lại không có tùy chọn đó. |
| `LLM_MAX_TOKENS` | `3000` | Trần token đầu ra chung; 0 nghĩa là không đặt trần. |
| `FILTER_MAX_TOKENS` | `2500` | Trần token đầu ra tầng 2. |
| `GAP_MAX_TOKENS` | `800` | Trần token đầu ra tầng 3. |
| `LLM_REASONING_EFFORT` | rỗng | Tùy chọn `low`, `medium` hoặc `high` cho provider hỗ trợ. Để trống với Ollama. |
| `LLM_RATE_LIMIT_RETRIES` | `0` | Số lần chờ và thử lại khi HTTP 429. |
| `LLM_MAX_WAIT` | `0` giây | Thời gian chờ tối đa mỗi lần retry 429. |
| `LLM_MIN_INTERVAL` | `0` giây | Khoảng nghỉ tối thiểu giữa hai request LLM. |
| `MAX_CODE_LENGTH` | `5000` ký tự | Giới hạn nội dung request; cấu hình Python mặc định nếu không có env là `20000`. |
| `BANDIT_TIMEOUT` | `30` giây | Timeout chạy Bandit. |
| `USE_RUFF`, `RUFF_TIMEOUT` | `1`, `30` | Bật Ruff và giới hạn thời gian chạy. |
| `RUFF_SELECT`, `RUFF_IGNORE` | cấu hình trong `config.py` | Nhóm rule Ruff được chọn/bỏ qua. |
| `RUFF_MAX_COMPLEXITY` | `15` | Ngưỡng C901. |
| `RUFF_MAX_ARGS` | `7` | Ngưỡng số tham số. |
| `RUFF_MAX_BRANCHES` | `15` | Ngưỡng số nhánh. |
| `RUFF_MAX_RETURNS` | `6` | Ngưỡng số return. |
| `RUFF_MAX_STATEMENTS` | `60` | Ngưỡng số statement. |
| `USE_STATIC` | `1` | Bật/tắt AST detectors tự viết. |
| `STATIC_MAX_NESTING` | `4` | Báo nesting lớn hơn ngưỡng này. |
| `STATIC_MIN_DUP_STMTS` | `4` | Số statement tối thiểu để xem xét hàm trùng. |
| `STATIC_MIN_DUP_BLOCK` | `3` | Số statement tối thiểu cho khối lệnh trùng. |
| `FILTER_CONTEXT_LINES` | `10` | Số dòng ngữ cảnh quanh candidate gửi tầng 2. |
| `FILTER_MAX_CANDIDATES` | `15` | Trần số candidate gửi tầng 2 cho mỗi file. |
| `USE_GAP_LAYER` | `1` | Bật/tắt tầng 3 của hybrid. |
| `GAP_MAX_ISSUES` | `3` | Số finding tối đa tầng 3 cho mỗi file. |

`GET /health` trả `llm_enabled`, `ruff_enabled` và `max_code_length`. `llm_enabled` chỉ phản ánh cấu hình, không phải health check riêng tới Ollama/provider.

## API

Hợp đồng chi tiết ở [docs/API_CONTRACT.md](docs/API_CONTRACT.md). Endpoint chính nhận `code`, `filename` tùy chọn và `mode` tùy chọn. `filename` hiện chỉ là metadata; nội dung code mới được phân tích.

```http
POST /review?mode=hybrid
Content-Type: application/json
```

```json
{
  "code": "def average(values):\n    return sum(values) / len(values)",
  "filename": "example.py",
  "mode": "hybrid"
}
```

`mode` có thể nằm trong query hoặc body; query có ưu tiên. Các giá trị hợp lệ: `bandit`, `tools`, `llm`, `filter`, `hybrid`.

Response có dạng:

```json
{
  "issues": [
    {
      "line": 2,
      "type": "bug",
      "severity": "medium",
      "confidence": "medium",
      "cwe_id": "CWE-369",
      "message": "Có thể chia cho 0 khi danh sách rỗng",
      "explanation": "Mẫu số len(values) bằng 0 khi values rỗng.",
      "suggestion": "    if len(values) == 0:\n        raise ValueError(\"Cannot evaluate an empty collection\")\n    return sum(values) / len(values)",
      "source": "static",
      "end_line": 2,
      "rule_id": "DIV001"
    }
  ],
  "meta": {
    "mode": "tools",
    "bandit_count": 0,
    "ruff_count": 0,
    "static_count": 1,
    "candidate_count": 1,
    "truncated_candidates": 0,
    "llm_count": 0,
    "dropped_invalid_lines": 0,
    "merged_count": 0,
    "llm_error": null,
    "tool_warnings": [],
    "suppressed_count": 0,
    "rejected_suggestions": 0
  }
}
```

### Trường `Issue`

| Trường | Mô tả |
|---|---|
| `line` | Dòng đầu nơi phát hiện lỗi, đánh số từ 1. |
| `end_line` | Dòng cuối của vùng code mà suggestion thay thế; có thể vắng mặt, khi đó mặc định bằng `line`. |
| `type` | `security`, `bug` hoặc `quality`. |
| `severity`, `confidence` | `high`, `medium` hoặc `low`. Severity là tác động; confidence là độ chắc chắn finding có thật trong snippet. |
| `cwe_id` | CWE dạng chuỗi hoặc `null`. |
| `message`, `explanation` | Tiêu đề và nguyên nhân. |
| `suggestion` | Bản vá code hoặc hướng khắc phục; không phải mọi finding đều có bản vá áp dụng tự động. |
| `source` | `bandit`, `ruff`, `static`, `llm` hoặc `both`. `both` là candidate công cụ được tầng 2 xác nhận. |
| `rule_id` | Rule công cụ hoặc category tầng 3; tùy chọn. |

Suggestion dùng `line..end_line` làm vùng code gốc cần thay. Không nên áp dụng tự động nếu backend không trả suggestion code hợp lệ hoặc vùng thay thế không rõ.

### Trường `meta`

`meta` gồm chế độ đã chạy, số candidate từ Bandit/Ruff/static, số candidate sau khử trùng, số candidate bị giới hạn, số finding tầng 3, số dòng/evidence bị loại, số finding trùng, lỗi LLM, cảnh báo công cụ, số finding bị LLM loại và số suggestion bị từ chối.

### Endpoint khác và lỗi HTTP

| Method | Path | Chức năng |
|---|---|---|
| `GET` | `/health` | Trạng thái backend, cấu hình LLM/Ruff, giới hạn ký tự. |
| `GET` | `/sample` | Code Python mẫu. |
| `POST` | `/mock/review` | Response minh họa; không chạy phân tích thật. |
| `POST` | `/review` | Phân tích code theo mode. |

- `400`: code rỗng hoặc chỉ có khoảng trắng.
- `413`: code vượt `MAX_CODE_LENGTH`.
- `422`: request hoặc `mode` sai schema.
- `500`: lỗi nội bộ backend.

## Web UI

Backend phục vụ UI ở `/` và tài nguyên ở `/static`. UI dùng HTML/CSS/JavaScript thuần và CodeMirror đã có sẵn trong repository; không cần Node.js hoặc bước build. Chức năng gồm:

- Chọn 5 chế độ review, lọc finding theo loại/severity/confidence và nhảy giữa finding với dòng code.
- Tải lên file `.py`, `.pyw` hoặc `.txt` tối đa 1 MiB; sao chép hoặc tải code xuống.
- Xem suggestion dạng bản vá trong phạm vi dòng API chỉ định, áp dụng vào editor và hoàn tác bằng nút hoặc `Ctrl+Z`. Bản vá quá rộng/không an toàn sẽ bị ẩn khỏi nút áp dụng.
- Lịch sử tối đa 20 lần review được lưu trong `localStorage` của trình duyệt hiện tại.
- Khi backend không kết nối được, có thể hiển thị một số heuristic offline để xem trước. Đây không phải kết quả tương đương Bandit/Ruff/LLM.

Code được gửi tới backend khi review; nếu cấu hình provider cloud, backend tiếp tục gửi code tới provider đó.

## Chrome Extension

Extension trong `extension/` là Chrome Manifest V3, không cần bundler:

1. Chạy backend ở `http://localhost:8000`.
2. Mở `chrome://extensions/`, bật **Developer mode**, chọn **Load unpacked** và chọn thư mục `extension/`.
3. Bôi đen code trên trang rồi chọn **Review với AI Code Reviewer** trong menu chuột phải; hoặc mở side panel và dán code.
4. Chọn mode và nhấn **Phân tích** hoặc `Ctrl+Enter`.

Trên trang file GitHub, extension thử tải nội dung raw. Nếu lựa chọn là toàn bộ file, side panel dùng nội dung file đầy đủ; nếu chỉ chọn một phần, extension giữ nguyên phần được chọn. Side panel hiển thị finding và suggestion để đọc/sao chép; thao tác áp dụng/hoàn tác trong editor hiện nằm ở Web UI.

URL mặc định đặt trong `extension/src/config.js`: `http://localhost:8000`; `DEPLOY_URL` để trống và `USE_MOCK=false`. Khi đổi host/port, cập nhật `host_permissions` trong `extension/manifest.json`. Sau khi sửa extension, bấm **Reload** tại `chrome://extensions/`; sau khi sửa `.env`, restart backend.

API client extension hủy request review trước khi bắt đầu request mới và có timeout 200 giây. LLM local có thể cần lâu hơn; nếu request timeout, cân nhắc giảm model/context hoặc sửa timeout extension phù hợp.

## Benchmark

Benchmark gọi API đang chạy, không tự khởi động backend. Bộ hiện tại có **30 mẫu**, tất cả split `dev`:

| Nhóm | Số mẫu |
|---|---:|
| Security | 12 |
| Bug | 6 |
| Quality | 4 |
| Clean | 5 |
| Prompt injection | 3 |

Nhãn nằm trong `benchmark/samples/labels.json`; quy ước ở [benchmark/samples/README.md](benchmark/samples/README.md). Chưa có mẫu thuộc `holdout` trong bộ hiện tại.

Cài dependencies benchmark:

```powershell
python -m pip install -r benchmark\requirements.txt
```

Chạy hybrid trên bộ dev:

```powershell
python benchmark\scripts\run_benchmark.py `
  --api http://localhost:8000 `
  --modes hybrid `
  --split dev `
  --repeats 1 `
  --timeout 1300
```

`run_benchmark.py` hỗ trợ `bandit`, `tools`, `llm`, `filter`, `hybrid`; mặc định chạy `bandit`. Timeout 1300 giây là giới hạn **mỗi request**, phù hợp hơn với model Ollama chậm. Benchmark kiểm tra `/health` trước; với mode cần LLM phải có `llm_enabled=true`. `--force` bỏ qua kiểm tra cấu hình đó, nhưng không sửa lỗi provider hoặc làm LLM hoạt động.

Kết quả thô theo mode/split/thời gian được ghi vào `benchmark/results/raw/`. Tạo bảng tổng hợp và biểu đồ từ lần chạy mới nhất của mỗi mode:

```powershell
python benchmark\scripts\make_figures.py --split dev
```

Report tạo `summary_<split>.json` và biểu đồ trong `benchmark/results/figures/`. Các lần chạy có lỗi API hoặc lỗi LLM được đánh dấu không hợp lệ; biểu đồ mặc định bỏ qua chúng. Chỉ dùng `--include-invalid` để xem chúng khi debug.

Matching yêu cầu cùng `type`, dòng trong dung sai mặc định ±2 hoặc khớp `also_lines`/`end_line`; CWE không bắt buộc trùng. Mỗi nhãn và dự đoán chỉ được ghép tối đa một lần. Precision/recall/F1 không tính ba mẫu prompt injection; nhóm này được chấm riêng theo việc vẫn tìm lỗi thật, không làm theo chỉ dẫn độc hại và giữ JSON hợp lệ. FPR là tỷ lệ file sạch có ít nhất một finding. Đây là phép đo trên bộ dev nhỏ, không đại diện cho mọi dự án Python và không thay thế holdout độc lập.

## Kiểm thử và lint

Từ thư mục gốc:

```powershell
python -m pytest backend/tests
python -m pytest benchmark/tests
python -m ruff check backend benchmark
```

Kiểm thử extension dùng Playwright và Chromium/Chrome; cài các thành phần đó riêng nếu muốn chạy `extension/tests`. Nếu thiếu Playwright hoặc browser, pytest có thể skip các test giao diện.

## Triển khai và giới hạn bảo mật

Repository có cấu hình Render ở `render.yaml` và lệnh start trong `Procfile`. Cấu hình Render hiện hướng tới provider OpenAI-compatible qua biến môi trường; Ollama chạy trên máy cá nhân thường không truy cập trực tiếp được từ dịch vụ hosting.

Trước khi mở backend ra Internet, cần xem lại:

- CORS hiện cho phép mọi origin; API chưa có authentication hoặc rate limiting.
- Request chứa code có thể phát sinh chi phí LLM hoặc bị gửi tới provider bên ngoài.
- `MAX_CODE_LENGTH`, timeout và giới hạn request không thay thế kiểm soát quota/người dùng.
- Bandit/Ruff/AST/LLM đều có thể bỏ sót hoặc báo nhầm; line/evidence/suggestion validation chỉ là guardrail, không chứng minh finding hay bản vá đúng.
- Không commit `backend/.env`; quản lý API key bằng secret của môi trường triển khai.

## Xử lý sự cố

| Triệu chứng | Kiểm tra/khắc phục |
|---|---|
| `ModuleNotFoundError: app` | Chạy lệnh từ thư mục gốc với `--app-dir backend`, hoặc vào `backend/` rồi chạy Uvicorn. |
| `GET /static/... 304 Not Modified` | Bình thường: trình duyệt đang dùng cache vì asset chưa đổi. Dùng `Ctrl+F5` nếu cần tải lại UI. |
| `llm_enabled=false` | Kiểm tra `USE_LLM`, API key hoặc URL local trong `backend/.env`; restart backend. |
| Ollama không kết nối được | Kiểm tra Ollama đang chạy, model đã tải, `LLM_BASE_URL` đúng (`http://127.0.0.1:11434/v1`) và endpoint `/v1/chat/completions` sẵn sàng. |
| LLM trả JSON sai hoặc bị cắt | Xem log retry/`finish_reason=length`; điều chỉnh `LLM_PARSE_RETRIES`, `FILTER_MAX_TOKENS`, `GAP_MAX_TOKENS` hoặc cấu hình structured output cho provider. |
| `413` | Rút ngắn code hoặc tăng `MAX_CODE_LENGTH`, rồi restart backend. |
| Extension không kết nối | Kiểm tra `http://localhost:8000/health`, URL ở `extension/src/config.js` và `host_permissions`; reload extension sau khi sửa manifest/code. |
| Benchmark dừng ngay | Kiểm tra backend, split/mẫu, `/health`; mode `llm`/`filter`/`hybrid` cần LLM được cấu hình. |
| Benchmark chạy rất lâu | Thời gian phụ thuộc số mẫu, số repeats, mode, model và tốc độ Ollama; bắt đầu với `--modes hybrid --repeats 1`. |

## Báo lỗi và thảo luận

GitHub Issues là kênh chính (bug tracker) để báo lỗi, đề xuất tính năng và theo dõi tiến độ sửa:

- Tạo issue: <https://github.com/kimnganvvv/AI-Code-Reviewer/issues/new>
- Danh sách issue: <https://github.com/kimnganvvv/AI-Code-Reviewer/issues>

Khi báo lỗi, nên kèm:

- Môi trường: OS, phiên bản Python, cách chạy (Web UI hoặc Chrome Extension).
- Chế độ review đang dùng: `bandit`, `tools`, `llm`, `filter` hoặc `hybrid`.
- Các bước tái hiện và đoạn code tối thiểu (đã xóa dữ liệu nhạy cảm, API key).
- Log lỗi hoặc response JSON, ảnh chụp màn hình nếu có.

GitHub Discussions (nếu được bật) là kênh phụ cho câu hỏi, ý tưởng và thảo luận dài; không bắt buộc. Nếu Discussions chưa bật, dùng Issues là đủ.

## Giấy phép

Dự án dùng MIT License; xem [LICENSE](LICENSE). Thư viện bên thứ ba giữ giấy phép riêng theo bản phân phối của chúng.
