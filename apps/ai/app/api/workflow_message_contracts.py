"""Phase 4 asynchronous workflow-message HTTP contracts."""

from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from app.api.contracts import ApiContractModel


class WorkflowMessageCreateRequest(ApiContractModel):
    """One idempotent employee message and its already-uploaded inputs."""

    content: str = Field(min_length=1, max_length=20_000)
    client_message_id: UUID
    selected_upload_ids: tuple[UUID, ...] = ()

    @field_validator("content")
    @classmethod
    def normalize_content(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("content must not be blank")
        return normalized

    @field_validator("selected_upload_ids")
    @classmethod
    def require_unique_uploads(cls, value: tuple[UUID, ...]) -> tuple[UUID, ...]:
        if len(value) != len(set(value)):
            raise ValueError("selectedUploadIds must be unique")
        return value


class WorkflowMessageAcceptedResponse(ApiContractModel):
    """Durable admission acknowledgement; completion arrives through SSE."""

    message_id: UUID
    workflow_run_id: UUID
    status: Literal["queued"] = "queued"
    events_url: str = Field(pattern=r"^/sessions/[0-9a-f-]{36}/events$")
