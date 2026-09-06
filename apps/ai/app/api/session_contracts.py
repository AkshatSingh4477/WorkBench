"""Public contracts for creating an employee-owned workflow session."""

from uuid import UUID

from pydantic import Field, field_validator

from app.api.contracts import ApiContractModel
from app.workflow.contracts import UtcTimestamp, WorkflowStage, WorkflowStatus, WorkflowType


class WorkflowSessionCreateRequest(ApiContractModel):
    """Create one workflow boundary before inputs or workflow execution exist."""

    workflow_type: WorkflowType
    title: str | None = Field(default=None, max_length=200)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        """Keep an optional title meaningful without changing its inner content."""

        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("title must not be blank when supplied")
        return normalized


class WorkflowSessionCreateResponse(ApiContractModel):
    """Safe workflow-session facts returned to its authenticated owner."""

    session_id: UUID
    workflow_type: WorkflowType
    title: str = Field(min_length=1, max_length=200)
    stage: WorkflowStage
    status: WorkflowStatus
    created_at: UtcTimestamp
