"""Hợp đồng JSON API v2 dùng chung cho Backend, Web UI, Chrome Extension và script đo.

Thay đổi file này = thay đổi hợp đồng cho toàn bộ nhóm. Chỉ được thay đổi sau khi
thông báo và thống nhất với Người 2 và Người 3.
"""

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

IssueType = Literal["security", "bug", "quality"]
Severity = Literal["high", "medium", "low"]
Confidence = Literal["high", "medium", "low"]
Source = Literal["bandit", "llm", "both"]
ReviewMode = Literal["bandit", "llm", "hybrid"]


class Issue(BaseModel):
    """Một phát hiện lỗi, đúng 10 trường theo hợp đồng trong đề tài."""

    line: int = Field(..., ge=1, description="Số dòng phát hiện (đã qua kiểm duyệt)")
    type: IssueType = Field(..., description="security | bug | quality")
    severity: Severity = Field(..., description="high | medium | low")
    confidence: Confidence = Field(..., description="high | medium | low")
    cwe_id: Optional[str] = Field(None, description="Mã CWE chuẩn quốc tế, ví dụ CWE-89")
    message: str = Field(..., description="Tiêu đề lỗi ngắn gọn")
    explanation: str = Field("", description="Nguyên nhân và luồng dữ liệu nguồn -> đích")
    suggestion: str = Field("", description="Mã đề xuất khắc phục")
    source: Source = Field(..., description="bandit | llm | both")
    end_line: Optional[int] = Field(
        None, ge=1,
        description="Dòng cuối mà `suggestion` thay thế (suggestion thay các dòng line..end_line). "
                    "Mặc định = line. Trường MỚI, tuỳ chọn, không phá tương thích.",
    )


class ReviewRequest(BaseModel):
    code: str = Field(..., description="Mã nguồn Python cần review")
    filename: str = Field("snippet.py", description="Tên file (chỉ dùng hiển thị)")
    mode: ReviewMode = Field(
        "hybrid",
        description="Chế độ chạy: bandit (chỉ SAST) | llm (chỉ LLM) | hybrid (Bandit + LLM)",
    )


class ReviewMeta(BaseModel):
    mode: str = Field(..., description="Chế độ đã chạy: bandit | llm | hybrid | mock")
    bandit_count: int = 0
    llm_count: int = 0
    dropped_invalid_lines: int = 0
    merged_count: int = 0
    llm_error: Optional[str] = None
    suppressed_count: int = Field(0, description="Số cảnh báo Bandit bị LLM loại là báo động giả")
    rejected_suggestions: int = Field(0, description="Số bản vá bị loại do hỏng cú pháp hoặc no-op")


class ReviewResponse(BaseModel):
    issues: List[Issue]
    meta: ReviewMeta


class PatchVerification(BaseModel):
    """Kết quả kiểm tra lại bản vá bằng unit test (llm_client.llm_verify_patch)."""

    verdict: Literal["VERIFIED_PASS", "REJECTED_REGRESSION", "INCONCLUSIVE"]
    explanation: str = ""
    defect_addressed: Literal["yes", "no", "unclear"] = "unclear"
    passed_tests: Optional[int] = None
    failed_tests: Optional[int] = None
    verdict_source: str = Field("llm", description="test_runner nếu verdict do code quyết định | llm")
    parse_error: bool = False