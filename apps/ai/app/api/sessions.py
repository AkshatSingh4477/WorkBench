"""Workflow-session creation route; later upload, event, and message routes are separate."""

from contextlib import suppress
from datetime import UTC, datetime
from typing import cast
from uuid import uuid4

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

from app.api.auth import AllowedOrigin, CurrentEmployee
from app.api.contracts import ErrorResponse
from app.api.session_contracts import WorkflowSessionCreateRequest, WorkflowSessionCreateResponse
from app.ports.backend2 import AuditAction, AuditRecord, AuditStore, WorkflowStore
from app.workflow.contracts import WorkflowSession, WorkflowStage, WorkflowStatus, WorkflowType

_WORKFLOW_STORE_UNAVAILABLE = (
    "workflow_store_unavailable",
    "The local workflow storage is unavailable.",
)

_CREATE_ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    401: {"model": ErrorResponse, "description": "Invalid employee session"},
    403: {"model": ErrorResponse, "description": "Request origin is not allowed"},
    422: {"model": ErrorResponse, "description": "Request validation failed"},
    503: {"model": ErrorResponse, "description": "Local workflow storage unavailable"},
}


def _error(code: str, message: str, status_code: int) -> JSONResponse:
    body = ErrorResponse(code=code, message=message)
    return JSONResponse(
        status_code=status_code,
        content=body.model_dump(mode="json", by_alias=True),
    )


def _default_title(workflow_type: WorkflowType) -> str:
    """Use a concise, workflow-specific title until the employee supplies one."""

    return {
        WorkflowType.INSPECTION_ANALYSIS: "Inspection analysis",
        WorkflowType.CODE_REPAIR: "Code repair",
    }[workflow_type]


def build_session_router() -> APIRouter:
    """Build the single workflow-session creation endpoint for this phase."""

    router = APIRouter(tags=["workflow sessions"])

    @router.post(
        "/sessions",
        response_model=WorkflowSessionCreateResponse,
        status_code=status.HTTP_201_CREATED,
        responses=_CREATE_ERROR_RESPONSES,
    )
    async def create_workflow_session(
        payload: WorkflowSessionCreateRequest,
        _: AllowedOrigin,
        user: CurrentEmployee,
        request: Request,
    ) -> WorkflowSessionCreateResponse | JSONResponse:
        """Persist an employee-owned workflow boundary in its initial input stage."""

        store = cast(WorkflowStore | None, getattr(request.app.state, "workflow_store", None))
        if store is None:
            return _error(*_WORKFLOW_STORE_UNAVAILABLE, status.HTTP_503_SERVICE_UNAVAILABLE)

        now = datetime.now(UTC)
        session = WorkflowSession(
            session_id=uuid4(),
            owner_user_id=user.user_id,
            workflow_type=payload.workflow_type,
            title=payload.title or _default_title(payload.workflow_type),
            stage=WorkflowStage.COLLECTING_INPUTS,
            status=WorkflowStatus.ACTIVE,
            created_at=now,
            updated_at=now,
        )
        try:
            created = await store.create_session(session)
        except Exception:
            return _error(*_WORKFLOW_STORE_UNAVAILABLE, status.HTTP_503_SERVICE_UNAVAILABLE)

        audit_store = cast(AuditStore | None, getattr(request.app.state, "audit_store", None))
        if audit_store is not None:
            # Audit availability is independent of the committed workflow boundary;
            # follow the current merged auth/chat convention and do not undo creation.
            with suppress(Exception):
                await audit_store.append(
                    AuditRecord(
                        audit_id=uuid4(),
                        action=AuditAction.SESSION_CREATED,
                        actor_user_id=user.user_id,
                        session_id=created.session_id,
                        outcome="created",
                        occurred_at=now,
                    )
                )

        return WorkflowSessionCreateResponse(
            session_id=created.session_id,
            workflow_type=created.workflow_type,
            title=created.title,
            stage=created.stage,
            status=created.status,
            created_at=created.created_at,
        )

    return router
