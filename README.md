# AI Code Reviewer

AI Code Reviewer là ứng dụng review mã Python, kết hợp **Bandit SAST** và mô hình ngôn ngữ lớn (LLM). Dự án gồm backend FastAPI, giao diện web tĩnh, tiện ích Chrome Manifest V3 và bộ benchmark để đánh giá kết quả.

> Công cụ hỗ trợ phân tích, không thay thế review của lập trình viên hoặc quy trình kiểm thử bảo mật. Kết quả LLM và các bản sửa được đề xuất có thể sai; hãy kiểm tra trước khi áp dụng.

## Mục lục

- [Tính năng](#tính-năng)
- [Kiến trúc và luồng review](#kiến-trúc-và-luồng-review)
- [Cấu trúc dự án](#cấu-trúc-dự-án)
- [Cài đặt và chạy backend](#cài-đặt-và-chạy-backend)
- [Cấu hình LLM](#cấu-hình-llm)
- [API](#api)
- [Web UI](#web-ui)
- [Chrome Extension](#chrome-extension)
- [Benchmark](#benchmark)
- [Kiểm thử và lint](#kiểm-thử-và-lint)
- [Triển khai](#triển-khai)
- [Giới hạn và lưu ý bảo mật](#giới-hạn-và-lưu-ý-bảo-mật)
- [Xử lý sự cố](#xử-lý-sự-cố)

## Tính năng

- Review mã Python theo ba chế độ: `bandit`, `llm` và `hybrid`.
- Chuẩn hóa phát hiện theo schema Pydantic dùng chung.
- Kiểm tra vị trí dòng, gộp một số phát hiện tương tự giữa Bandit và LLM, sắp xếp theo dòng và mức độ nghiêm trọng.
- Web UI dùng HTML, CSS, JavaScript thuần và CodeMirror; không có bước build Node.js.
- Chrome Extension cho phép gửi đoạn code được chọn trên trang web hoặc dán code trong side panel.
- Benchmark có nhãn mẫu, matching theo loại và vị trí dòng, thống kê precision/recall/F1, FPR và latency.

## Kiến trúc và luồng review

```text
Web UI / Chrome Extension / benchmark client
                    |
                    v
              FastAPI backend
                /       \
         Bandit SAST    LLM API
                \       /
         xác thực, gộp, sắp xếp
                    |
                    v
          { "issues": [...], "meta": {...} }
```

| Chế độ | Bandit | LLM | Hành vi |
|---|:---:|:---:|---|
| `bandit` | Có | Không | Chỉ chạy Bandit; không yêu cầu cấu hình LLM. |
| `llm` | Không | Có | Gửi code để LLM phân tích độc lập. Nếu LLM không sẵn sàng, trả danh sách issue rỗng và ghi lý do trong `meta.llm_error`. |
| `hybrid` | Có | Có | Đưa code và phát hiện Bandit vào prompt; LLM thẩm định cảnh báo và có thể đưa thêm issue. Nếu LLM lỗi, backend vẫn có thể trả kết quả Bandit cùng `meta.llm_error`. |

Trong luồng hybrid bình thường, backend yêu cầu LLM thực hiện thẩm định và tìm lỗi mới trong cùng một lượt review. Tuy vậy, client có thể gửi lại yêu cầu khi phản hồi JSON sai định dạng, gặp HTTP 429 hoặc lỗi kết nối; vì vậy không nên hiểu “single-pass” là đảm bảo luôn chỉ có đúng một HTTP request.

Backend kiểm tra số dòng hợp lệ, kiểm tra bằng chứng của issue mới do LLM trả về, xác thực cú pháp các suggestion theo logic trong `prompts.py`, rồi gộp và sắp xếp kết quả. Quy tắc ghép dựa trên nguồn, CWE, dòng, loại issue và độ tương đồng thông điệp; đây là heuristic, không phải bằng chứng chắc chắn rằng hai phát hiện là cùng một lỗi.

## Cấu trúc dự án

```text
backend/
  app/
    main.py            # HTTP routes, CORS, static web files
    schemas.py         # Pydantic request/response contract
    config.py          # Cấu hình runtime và phát hiện LLM local
    bandit_runner.py   # Chạy Bandit, ánh xạ test ID/CWE
    llm_client.py      # OpenAI-compatible client và retry
    prompts.py         # Prompt, parse/validate kết quả LLM
    pipeline.py        # Điều phối các chế độ review
    mock_data.py       # Dữ liệu minh họa cho sample/mock endpoints
  tests/               # Backend API và pipeline tests
  web/                 # Web UI tĩnh
benchmark/
  samples/             # Mã mẫu và labels.json
  src/                 # HTTP client, matching, metrics, report
  scripts/             # Chạy benchmark và vẽ biểu đồ
  tests/               # Unit tests của benchmark
extension/
  manifest.json        # Chrome Manifest V3
  background.js        # Context menu và mở side panel
  sidepanel/           # Giao diện và logic side panel
  src/                 # API client, render, config, storage
docs/
  API_CONTRACT.md      # Mô tả hợp đồng API
  ARCHITECTURE.md      # Ghi chú kiến trúc
```

## Cài đặt và chạy backend

Yêu cầu Python **3.10 trở lên**. Mở PowerShell ở thư mục gốc repository:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
```

Tạo file cấu hình nếu cần dùng LLM. Backend cũng có thể chạy không có file `.env`; khi đó, nếu LLM chưa được cấu hình, có thể sử dụng chế độ Bandit:

```powershell
if (-not (Test-Path .\backend\.env)) {
    Copy-Item .\backend\.env.example .\backend\.env
}
```

Khởi động server từ thư mục gốc:

```powershell
python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Địa chỉ mặc định:

- Web UI: <http://127.0.0.1:8000/>
- Swagger UI: <http://127.0.0.1:8000/docs>
- Health check: <http://127.0.0.1:8000/health>

Để cho thiết bị khác truy cập server trong mạng, thay `127.0.0.1` bằng `0.0.0.0`; chỉ làm việc này trong môi trường mạng đáng tin cậy và có biện pháp bảo vệ phù hợp.

## Cấu hình LLM

Backend đọc `backend/.env` khi khởi động. Chỉnh các biến dưới đây rồi khởi động lại server:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `USE_LLM` | `1` | Cho phép dùng LLM nếu có cấu hình hợp lệ. Đặt `0` để tắt. |
| `LLM_API_KEY` | rỗng | API key của dịch vụ tương thích OpenAI. Có thể để rỗng khi dùng endpoint local. |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Base URL; client gọi đường dẫn `/chat/completions`. |
| `LLM_MODEL` | `gpt-4o-mini` | Tên model gửi trong request. |
| `LLM_TEMPERATURE` | `0` | Temperature của request. |
| `MAX_CODE_LENGTH` | `20000` | Giới hạn số ký tự nhận từ API. |
| `BANDIT_TIMEOUT` | `30` giây | Timeout chạy Bandit. |
| `LLM_TIMEOUT` | `90` giây | Timeout mỗi request LLM. |

LLM được coi là đã cấu hình khi `USE_LLM=1` và có API key, hoặc `LLM_BASE_URL` trỏ đến `localhost`/`127.0.0.1`. Các biến client nâng cao như `LLM_MAX_TOKENS`, `LLM_PARSE_RETRIES`, `LLM_RATE_LIMIT_RETRIES`, `LLM_MAX_WAIT`, `LLM_MIN_INTERVAL` và `LLM_STRUCTURED_OUTPUT` được đọc trong `backend/app/llm_client.py`.

Ví dụ dùng API tương thích OpenAI:

```ini
USE_LLM=1
LLM_API_KEY=your_api_key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

Ví dụ dùng Ollama local với OpenAI-compatible API (để trống API key):

```ini
USE_LLM=1
LLM_API_KEY=
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5-coder:1.5b
```

Tên model và khả năng tương thích phụ thuộc nhà cung cấp. Thời gian phản hồi cũng phụ thuộc model, phần cứng và mạng; README không giả định một tốc độ hoặc mức tiết kiệm token cố định.

## API

Đặc tả chi tiết nằm trong [docs/API_CONTRACT.md](docs/API_CONTRACT.md). `POST /review` nhận `code`, `filename` tùy chọn và `mode` tùy chọn. `filename` hiện chỉ là trường request; logic review hiện tại phân tích nội dung code.

```http
POST /review?mode=hybrid
Content-Type: application/json
```

```json
{
  "code": "query = f\"SELECT * FROM users WHERE id = {user_id}\"\n",
  "filename": "example.py",
  "mode": "hybrid"
}
```

`mode` có thể được truyền trong query hoặc body; query có ưu tiên cao hơn body. Giá trị hợp lệ là `bandit`, `llm`, `hybrid`; mặc định `hybrid`.

Ví dụ response:

```json
{
  "issues": [
    {
      "line": 1,
      "type": "security",
      "severity": "high",
      "confidence": "high",
      "cwe_id": "CWE-89",
      "message": "Possible SQL injection",
      "explanation": "Giá trị đầu vào được ghép trực tiếp vào câu truy vấn.",
      "suggestion": "Dùng truy vấn tham số hóa.",
      "source": "both",
      "end_line": 1
    }
  ],
  "meta": {
    "mode": "hybrid",
    "bandit_count": 1,
    "llm_count": 0,
    "dropped_invalid_lines": 0,
    "merged_count": 1,
    "llm_error": null,
    "suppressed_count": 0,
    "rejected_suggestions": 0
  }
}
```

Mỗi `Issue` có 10 trường trong response: `line`, `type`, `severity`, `confidence`, `cwe_id`, `message`, `explanation`, `suggestion`, `source`, `end_line`. `end_line` là trường tùy chọn trong schema và được chuẩn hóa về dòng đơn khi không có khoảng dòng. Các giá trị `type`: `security`, `bug`, `quality`; `severity` và `confidence`: `high`, `medium`, `low`; `source`: `bandit`, `llm`, `both`.

`meta` có thể gồm:

- `mode`: chế độ thực hiện.
- `bandit_count`, `llm_count`: số phát hiện Bandit ban đầu và số issue mới từ LLM.
- `dropped_invalid_lines`: số issue bị loại vì dòng không hợp lệ hoặc bằng chứng không khớp.
- `merged_count`: số issue được gộp.
- `llm_error`: thông tin lỗi/cấu hình LLM, nếu có.
- `suppressed_count`: số finding Bandit bị LLM loại.
- `rejected_suggestions`: số suggestion không qua kiểm tra.

Các endpoint hỗ trợ:

| Method | Đường dẫn | Mô tả |
|---|---|---|
| `GET` | `/health` | Trả trạng thái backend, LLM có sẵn hay không và giới hạn ký tự. |
| `GET` | `/sample` | Trả code mẫu Python trong trường `code`. |
| `POST` | `/mock/review` | Trả dữ liệu minh họa; không chạy phân tích thật. |

Các lỗi chính: `400` khi code rỗng, `413` khi vượt `MAX_CODE_LENGTH`, `422` khi body hoặc mode không hợp lệ, và `500` khi xử lý review gặp lỗi backend.

## Web UI

Web UI được phục vụ bởi backend tại `/` và tài nguyên tĩnh tại `/static`. Các chức năng hiện có:

- Editor CodeMirror cho Python; phím tắt `Ctrl+Enter` hoặc `Cmd+Enter` để review.
- Chọn chế độ, lọc theo loại lỗi/mức độ/độ tin cậy, click issue để tới dòng tương ứng và click dòng code để chọn issue liên quan.
- Tải lên file `.py`, `.pyw` hoặc `.txt` tối đa 1 MiB; tải code hiện tại xuống hoặc sao chép code.
- Xem và áp dụng suggestion vào editor; có thể hoàn tác thao tác áp dụng.
- Lịch sử review được lưu trong `localStorage` trên trình duyệt, tối đa **20** mục. Có thể mở lại hoặc xóa lịch sử.

Lịch sử nằm trên trình duyệt hiện tại, không phải cơ sở dữ liệu backend. Tuy nhiên, khi gửi review, code vẫn được gửi tới backend và có thể được chuyển tiếp tới nhà cung cấp LLM nếu dùng dịch vụ bên ngoài.

## Chrome Extension

Extension trong `extension/` là Chrome Manifest V3, không cần bundler:

1. Chạy backend tại `http://localhost:8000`.
2. Mở `chrome://extensions/`, bật **Developer mode**, chọn **Load unpacked** và chọn thư mục `extension/`.
3. Bôi đen code trên trang web rồi mở menu chuột phải **Review với AI Code Reviewer**, hoặc mở side panel và dán code.
4. Chọn `bandit`, `llm` hoặc `hybrid`, rồi nhấn **Phân tích** (cũng hỗ trợ `Ctrl+Enter`).

`extension/src/config.js` điều khiển `USE_MOCK`, `LOCAL_URL` và `DEPLOY_URL`. Mặc định extension gọi backend local, `USE_MOCK=false`, `DEPLOY_URL` để trống. Host permissions hiện cho phép localhost/127.0.0.1 cổng 8000 và subdomain `onrender.com`; nếu đổi endpoint cần cập nhật manifest cho phù hợp.

Side panel lưu chế độ review trong Chrome local storage, lọc kết quả theo severity/confidence, hiển thị suggestion và có nút sao chép. Request bị hủy sau 120 giây; request đang chạy trước đó bị hủy khi bắt đầu review mới. API client không thực hiện retry request review.

## Benchmark

Benchmark gửi cùng bộ dữ liệu qua API đang chạy; nó không tự khởi động backend. Cấu hình nhãn ở `benchmark/samples/labels.json`; cách gán nhãn được mô tả trong [benchmark/samples/README.md](benchmark/samples/README.md).

Bộ dữ liệu hiện có **30 mẫu, tất cả thuộc split `dev`**:

| Nhóm | Số mẫu |
|---|---:|
| Security | 12 |
| Bug | 6 |
| Quality | 4 |
| Clean | 5 |
| Prompt injection | 3 |

Matching yêu cầu cùng `type` và số dòng trong dung sai (mặc định ±2), hỗ trợ `end_line` và `also_lines`; CWE không bắt buộc trùng. Các mẫu prompt injection được theo dõi riêng và không tính vào precision/recall/F1 chính. FPR là tỷ lệ file sạch có ít nhất một cảnh báo. Báo cáo còn lưu latency (median, p95, mean), lỗi API và lỗi LLM; kết quả có lỗi được đánh dấu không hợp lệ, và biểu đồ mặc định bỏ qua kết quả không hợp lệ. Đây là phép đo trên bộ mẫu hiện tại, không đại diện cho mọi dự án Python.

Cài dependencies benchmark nếu cần chạy benchmark/vẽ biểu đồ:

```powershell
python -m pip install -r benchmark\requirements.txt
```

Chạy backend trước, sau đó từ thư mục gốc:

```powershell
python benchmark\scripts\run_benchmark.py --api http://localhost:8000 --modes bandit llm hybrid --split dev --repeats 1
```

Để chạy chế độ `llm` hoặc `hybrid`, backend phải báo `llm_enabled=true`; script sẽ dừng nếu LLM chưa sẵn sàng, trừ khi truyền `--force`. Kết quả thô được ghi vào `benchmark/results/raw/`. Vẽ lại báo cáo từ các lần chạy gần nhất cho mỗi chế độ:

```powershell
python benchmark\scripts\make_figures.py --split dev
```

Các file tổng hợp và biểu đồ được tạo trong `benchmark/results/`. Bộ dữ liệu hiện chưa có mẫu thuộc split `holdout`; tùy chọn `--split holdout` chỉ hữu ích sau khi bổ sung nhãn cho split đó.

## Kiểm thử và lint

Từ thư mục gốc:

```powershell
python -m pytest backend/tests
```

Benchmark tests (theo hướng dẫn chạy từ chính thư mục benchmark):

```powershell
Set-Location .\benchmark
python -m pytest tests
Set-Location ..
```

Lint benchmark:

```powershell
python -m ruff check benchmark
```

## Triển khai

Repository có cấu hình Render trong `render.yaml` và lệnh khởi động `Procfile`. Cấu hình Render cài `backend/requirements.txt`, chạy Uvicorn trên cổng do môi trường cung cấp và để `LLM_API_KEY` nhập riêng trong dashboard. Các biến model/URL khác có thể được cấu hình trong môi trường deploy.

Trước khi đưa lên môi trường công khai, cần xem lại CORS, xác thực, giới hạn tần suất, giới hạn chi phí LLM và chính sách lưu/chuyển tiếp code. Cấu hình hiện tại không có xác thực người dùng hoặc rate limiting và bật CORS `*`.

## Giới hạn và lưu ý bảo mật

- Bandit là phân tích tĩnh theo rule; LLM có thể bỏ sót hoặc báo nhầm. Không xem `source: "both"` là bảo đảm tuyệt đối.
- Line validation chỉ xác nhận dòng nằm trong phạm vi code; nó không chứng minh nội dung phát hiện là chính xác.
- Kiểm tra suggestion trong backend xác nhận một số điều kiện cấu trúc/cú pháp; nó không chứng minh bản sửa đúng nghiệp vụ hoặc hết lỗ hổng.
- Khi cấu hình cloud LLM, code review được gửi tới URL dịch vụ đã chọn. Tránh gửi secret hoặc dữ liệu nhạy cảm nếu chưa được phép.
- API không có authentication/rate limit và CORS rộng; không nên để endpoint public mà không bổ sung lớp bảo vệ.
- `backend/.env` chứa API key nên không commit file này.

## Xử lý sự cố

| Triệu chứng | Cách kiểm tra/khắc phục |
|---|---|
| `ModuleNotFoundError: app` | Chạy lệnh từ thư mục gốc với `--app-dir backend`, hoặc đổi vào `backend/` rồi chạy Uvicorn. |
| LLM báo chưa cấu hình | Kiểm tra `USE_LLM`, `LLM_API_KEY` hoặc `LLM_BASE_URL` local trong `backend/.env`, sau đó khởi động lại server. |
| `413` khi review | Rút ngắn code hoặc điều chỉnh `MAX_CODE_LENGTH`, rồi restart backend. |
| Extension không kết nối được | Kiểm tra backend tại `http://localhost:8000/health`, `LOCAL_URL`/`DEPLOY_URL` và `host_permissions` trong manifest. |
| Benchmark không chạy `llm`/`hybrid` | Kiểm tra `/health`; điền cấu hình LLM và restart backend. Chỉ dùng `--force` khi chủ động muốn chạy dù health báo LLM tắt. |
| LLM chậm hoặc HTTP 429 | Kiểm tra giới hạn của nhà cung cấp, model, timeout và retry trong `backend/app/llm_client.py`; latency thay đổi tùy môi trường. |
