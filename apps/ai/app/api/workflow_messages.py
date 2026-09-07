"""Asynchronous Phase 4 message admission over Phase 3 workflow sessions."""

from datetime import UTC, datetime
from typing import Annotated, cast
from uuid import UUID, uuid4

from fastapi import APIRouter, Path, Request, status
from fastapi.responses import JSONResponse

from app.api.auth import AllowedOrigin, CurrentEmployee
from app.api.contracts import ErrorResponse
from app.api.workflow_message_contracts import (
    WorkflowMessageAcceptedResponse,
    WorkflowMessageCreateRequest,
)
from app.ports.local_backend import (
    SelectedUploadSnapshot,
    SessionFileStore,
    WorkflowAdmissionStatus,
    WorkflowMessage,
    WorkflowRunAdmissionRequest,
    WorkflowStore,
)
from app.storage import WorkflowSessionNotFoundError
from app.storage.sqlite import WorkflowAdmissionConflictError, WorkflowRunContextMismatchError
from app.workflow.contracts import WorkflowRun, WorkflowRunStatus, WorkflowStage
from app.workflow.supervisor import WorkflowTaskSupervisor

_UNAVAILABLE = ("workflow_unavailable", "The local workflow service is unavailable.")
_NOT_FOUND = ("session_not_found", "The workflow session was not found for this employee.")

SessionId = Annotated[UUID, Path(description="Owned workflow session identifier")]


def _error(code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponse(code=code, message=message).model_dump(mode="json", by_alias=True),
    )


def build_workflow_message_router() -> APIRouter:
    """Build the single Phase 4 message-admission route."""

    router = APIRouter(tags=["workflow messages"])

    @router.post(
        "/sessions/{session_id}/messages",
        response_model=WorkflowMessageAcceptedResponse,
        status_code=status.HTTP_202_ACCEPTED,
        responses={
            401: {"model": ErrorResponse},
            403: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
            409: {"model": ErrorResponse},
            422: {"model": ErrorResponse},
            503: {"model": ErrorResponse},
        },
    )
    async def create_workflow_message(
        session_id: SessionId,
        payload: WorkflowMessageCreateRequest,
        _: AllowedOrigin,
        user: CurrentEmployee,
        request: Request,
    ) -> WorkflowMessageAcceptedResponse | JSONResponse:
        """Atomically admit work, then hand it to the in-process supervisor."""

        workflows = cast(WorkflowStore | None, getattr(request.app.state, "workflow_store", None))
        files = cast(
            SessionFileStore | None, getattr(request.app.state, "session_file_store", None)
        )
        supervisor = cast(
            WorkflowTaskSupervisor | None,
            getattr(request.app.state, "workflow_supervisor", None),
        )
        if workflows is None or files is None or supervisor is None:
            return _error(*_UNAVAILABLE, status.HTTP_503_SERVICE_UNAVAILABLE)
        try:
            session = await workflows.get_session(session_id, user.user_id)
        except WorkflowSessionNotFoundError:
            return _error(*_NOT_FOUND, status.HTTP_404_NOT_FOUND)
        except Exception:
            return _error(*_UNAVAILABLE, status.HTTP_503_SERVICE_UNAVAILABLE)
        snapshots: list[SelectedUploadSnapshot] = []
        try:
            for upload_id in payload.selected_upload_ids:
                stored = await files.get_upload(
                    upload_id=upload_id,
                    session_id=session.session_id,
                    owner_user_id=user.user_id,
                )
                approved = await files.resolve_approved_path(
                    upload_id=upload_id,
                    session_id=session.session_id,
                    owner_user_id=user.user_id,
                )
                if (
                    stored is None
                    or approved is None
                    or approved.source_id != str(stored.source_id)
                ):
                    return _error(
                        "upload_not_found",
                        "A selected upload is unavailable.",
                        status.HTTP_404_NOT_FOUND,
                    )
                snapshots.append(
                    SelectedUploadSnapshot(
                        upload_id=stored.upload_id,
                        session_id=stored.session_id,
                        owner_user_id=user.user_id,
                        source_id=stored.source_id,
                        file_name=stored.file_name,
                        mime_type=stored.mime_type,
                        size_bytes=stored.size_bytes,
                        sha256=stored.sha256,
                    )
                )
        except Exception:
            return _error(*_UNAVAILABLE, status.HTTP_503_SERVICE_UNAVAILABLE)

        if session.workflow_type.value == "inspectionAnalysis" and not snapshots:
            return _error(
                "inspection_input_required",
                "Inspection analysis requires at least one selected inspection upload.",
                status.HTTP_422_UNPROCESSABLE_CONTENT,
            )

        now = datetime.now(UTC)
        try:
            admission = await workflows.admit_run(
                WorkflowRunAdmissionRequest(
                    run=WorkflowRun(
                        workflow_run_id=uuid4(),
                        session_id=session.session_id,
                        owner_user_id=user.user_id,
                        workflow_type=session.workflow_type,
                        stage=WorkflowStage.COLLECTING_INPUTS,
                        stage_version=0,
                        status=WorkflowRunStatus.QUEUED,
                        created_at=now,
                        updated_at=now,
                    ),
                    message=WorkflowMessage(
                        message_id=uuid4(),
                        session_id=session.session_id,
                        author_user_id=user.user_id,
                        role="user",
                        content=payload.content,
                        created_at=now,
                        client_message_id=payload.client_message_id,
                    ),
                    selected_uploads=tuple(snapshots),
                )
            )
        except WorkflowAdmissionConflictError:
            return _error(
                "workflow_busy",
                "This workflow session already has active work.",
                status.HTTP_409_CONFLICT,
            )
        except WorkflowRunContextMismatchError:
            return _error(
                "invalid_workflow_stage",
                "This workflow session no longer accepts messages.",
                status.HTTP_409_CONFLICT,
            )
        except Exception:
            return _error(*_UNAVAILABLE, status.HTTP_503_SERVICE_UNAVAILABLE)

        if admission.status is WorkflowAdmissionStatus.CREATED:
            try:
                supervisor.submit(admission)
            except RuntimeError:
                return _error(*_UNAVAILABLE, status.HTTP_503_SERVICE_UNAVAILABLE)
        return WorkflowMessageAcceptedResponse(
            message_id=admission.message.message_id,
            workflow_run_id=admission.run.workflow_run_id,
            events_url=f"/sessions/{admission.run.session_id}/events",
        )

    return router
