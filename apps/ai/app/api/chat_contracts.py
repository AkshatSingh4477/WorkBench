"""Employee chat request and response-envelope contracts for the local API."""

from uuid import UUID

from pydantic import Field, field_validator

from app.ai.schemas import InferenceMetrics
from app.api.contracts import ApiContractModel
from app.ports.local_backend import WorkflowMessage
from app.workflow.contracts import WorkflowSession, WorkflowType


class ChatSessionCreateRequest(ApiContractModel):
    """Create one owned chat thread backed by a workflow session.

    ``client_session_id`` is the renderer's idempotency key: when FastAPI
    commits the session but its response is lost, a retry of the same create
    returns the already stored session instead of creating a duplicate.
    """

    workflow_type: WorkflowType
    title: str = Field(min_length=1, max_length=200)
    client_session_id: UUID | None = None


class ChatSessionListEnvelope(ApiContractModel):
    """The employee's own chat threads, most recently updated first."""

    sessions: list[WorkflowSession]


class ChatMessageAppendRequest(ApiContractModel):
    """One employee-authored chat message; the service strips outer whitespace.

    ``client_message_id`` is the renderer's idempotency key: a retry of the
    same append returns the already stored message instead of duplicating it.
    """

    content: str = Field(min_length=1, max_length=20_000)
    client_message_id: UUID
    selected_upload_ids: tuple[UUID, ...] = ()

    @field_validator("selected_upload_ids")
    @classmethod
    def require_unique_uploads(cls, value: tuple[UUID, ...]) -> tuple[UUID, ...]:
        if len(value) != len(set(value)):
            raise ValueError("selectedUploadIds must be unique")
        return value


class ChatMessageListEnvelope(ApiContractModel):
    """The latest messages of one chat thread in chronological order."""

    messages: list[WorkflowMessage]


class ConversationCreateRequest(ApiContractModel):
    """One text-only chat turn; extra workflow and retrieval fields are rejected."""

    message: str = Field(min_length=1, max_length=20_000)
    client_request_id: UUID | None = None


class ConversationCreateResponse(ApiContractModel):
    """Persisted identifiers and safe facts for one complete local reply."""

    session_id: UUID
    user_message_id: UUID
    assistant_message_id: UUID
    assistant_text: str = Field(min_length=1, max_length=20_000)
    selected_model: str = Field(min_length=1)
    used_fallback: bool
    fallback_reason: str | None = None
    metrics: InferenceMetrics | None = None
