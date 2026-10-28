"""Hợp đồng JSON API v2 dùng chung cho Backend, Web UI, Chrome Extension và script đo.

Thay đổi file này = thay đổi hợp đồng cho toàn bộ nhóm. Chỉ được thay đổi sau khi
thông báo và thống nhất với Người 2 và Người 3.
"""

from typing import Literal

from pydantic import BaseModel, Field

IssueType = Literal["security", "bug", "quality"]
Severity = Literal["high", "medium", "low"]
Confidence = Literal["high", "medium", "low"]
# bandit|ruff|static: ứng viên của công cụ, chưa được LLM xác nhận (hoặc LLM không phán quyết).
# both: ứng viên của công cụ đã được LLM (Tầng 2) xác nhận.  llm: lỗi do LLM Tầng 3 tìm thêm.
Source = Literal["bandit", "ruff", "static", "llm", "both"]
# bandit : chỉ Bandit, không LLM
# tools  : Tầng 1 (Bandit + Ruff + static), không LLM
# llm    : 1 lượt LLM tự do, không công cụ (mốc so sánh)
# filter : Tầng 1 + Tầng 2
# hybrid : Tầng 1 + Tầng 2 + Tầng 3 (mặc định)
ReviewMode = Literal["bandit", "tools", "llm", "filter", "hybrid"]


class Issue(BaseModel):
    """Một phát hiện lỗi, đúng 10 trường theo hợp đồng trong đề tài."""

    line: int = Field(..., ge=1, description="Số dòng phát hiện (đã qua kiểm duyệt)")
    type: IssueType = Field(..., description="security | bug | quality")
    severity: Severity = Field(..., description="high | medium | low")
    confidence: Confidence = Field(..., description="high | medium | low")
    cwe_id: str | None = Field(None, description="Mã CWE chuẩn quốc tế, ví dụ CWE-89")
    message: str = Field(..., description="Tiêu đề lỗi ngắn gọn")
    explanation: str = Field("", description="Nguyên nhân và luồng dữ liệu nguồn -> đích")
    suggestion: str = Field("", description="Mã đề xuất khắc phục")
    source: Source = Field(..., description="bandit | ruff | static | llm | both")
    end_line: int | None = Field(
        None, ge=1,
        description="Dòng cuối mà `suggestion` thay thế (suggestion thay các dòng line..end_line). "
                    "Mặc định = line. Trường MỚI, tuỳ chọn, không phá tương thích.",
    )
    rule_id: str | None = Field(
        None,
        description="Mã rule gốc (B608, F401, C901, NEST001, DUP001) hoặc category của Tầng 3 "
                    "(division_by_zero, race_condition, data_exposure, idor). Trường MỚI, tuỳ chọn.",
    )


class ReviewRequest(BaseModel):
    code: str = Field(..., description="Mã nguồn Python cần review")
    filename: str = Field("snippet.py", description="Tên file (chỉ dùng hiển thị)")
    mode: ReviewMode = Field(
        "hybrid",
        description="Chế độ chạy: bandit | tools | llm | filter | hybrid (xem ReviewMode)",
    )


class ReviewMeta(BaseModel):
    mode: str = Field(..., description="Chế độ đã chạy: bandit | tools | llm | filter | hybrid | mock")
    bandit_count: int = Field(0, description="Số ứng viên Bandit (Tầng 1)")
    ruff_count: int = Field(0, description="Số ứng viên Ruff (Tầng 1)")
    static_count: int = Field(0, description="Số ứng viên của bộ phát hiện tự viết (Tầng 1)")
    candidate_count: int = Field(0, description="Số ứng viên sau khi khử trùng giữa các công cụ")
    truncated_candidates: int = Field(0, description="Số ứng viên vượt trần FILTER_MAX_CANDIDATES, không gửi LLM")
    llm_count: int = Field(0, description="Số lỗi do LLM tự tìm thêm (Tầng 3; hoặc mode=llm)")
    dropped_invalid_lines: int = 0
    merged_count: int = 0
    llm_error: str | None = None
    tool_warnings: list[str] = Field(default_factory=list, description="Cảnh báo từ Tầng 1 (Ruff thiếu, lỗi cú pháp...)")
    suppressed_count: int = Field(0, description="Số ứng viên bị LLM (Tầng 2) loại là báo động giả/nhiễu")
    rejected_suggestions: int = Field(0, description="Số bản vá bị loại do hỏng cú pháp hoặc no-op")


class ReviewResponse(BaseModel):
    issues: list[Issue]
    meta: ReviewMeta


class PatchVerification(BaseModel):
    """Kết quả kiểm tra lại bản vá bằng unit test (llm_client.llm_verify_patch)."""

    verdict: Literal["VERIFIED_PASS", "REJECTED_REGRESSION", "INCONCLUSIVE"]
    explanation: str = ""
    defect_addressed: Literal["yes", "no", "unclear"] = "unclear"
    passed_tests: int | None = None
    failed_tests: int | None = None
    verdict_source: str = Field("llm", description="test_runner nếu verdict do code quyết định | llm")
    parse_error: bool = False