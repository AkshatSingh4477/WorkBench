"""Phase 4 orchestration tests using durable local stores and deterministic AI."""

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

import pytest

from app.ai.fakes import FakeAIEngine
from app.ai.schemas import (
    AgentProposal,
    Capability,
    CapabilityDecision,
    ProposedToolCall,
    TaskDescriptor,
)
from app.config import ApplicationSettings
from app.main import compose_runtime_dependencies, create_app
from app.ports.local_backend import (
    SelectedUploadSnapshot,
    WorkflowMessage,
    WorkflowRunAdmission,
    WorkflowRunAdmissionRequest,
)
from app.storage import (
    LocalSessionWorkspaceStore,
    LocalSQLiteDatabase,
    SQLiteActivityEventStore,
    SQLiteApprovalStore,
    SQLiteDraftStore,
    SQLiteSessionFileStore,
    SQLiteWorkflowStore,
)
from app.tools.registry import ToolRegistry
from app.workflow.contracts import (
    ActivityEventType,
    WorkflowRun,
    WorkflowRunStatus,
    WorkflowSession,
    WorkflowStage,
    WorkflowType,
)
from app.workflow.runner import CheckpointAwareWorkflowRunner, LocalInspectionWorkflowInputPolicy

NOW = datetime(2026, 9, 7, 12, tzinfo=UTC)


async def _content(value: bytes) -> AsyncIterator[bytes]:
    yield value


async def _admit(
    tmp_path: Path,
    workflow_type: WorkflowType,
    *,
    file_name: str,
    mime_type: str,
    content: bytes,
    message_content: str = "Review the selected local input.",
) -> tuple[
    SQLiteWorkflowStore,
    SQLiteDraftStore,
    SQLiteApprovalStore,
    SQLiteActivityEventStore,
    SQLiteSessionFileStore,
    WorkflowRunAdmission,
]:
    database = LocalSQLiteDatabase(tmp_path / "workbench.db")
    await database.initialize()
    workflows = SQLiteWorkflowStore(database)
    files = SQLiteSessionFileStore(database, LocalSessionWorkspaceStore(tmp_path / "sessions"))
    owner_id, session_id = uuid4(), uuid4()
    session = WorkflowSession(
        session_id=session_id,
        owner_user_id=owner_id,
        workflow_type=workflow_type,
        title="Phase 4",
        created_at=NOW,
        updated_at=NOW,
    )
    await workflows.create_session(session)
    stored = await files.save_upload(
        session=session,
        upload_id=uuid4(),
        source_id=uuid4(),
        file_name=file_name,
        mime_type=mime_type,
        content=_content(content),
    )
    snapshot = SelectedUploadSnapshot(
        upload_id=stored.upload_id,
        session_id=stored.session_id,
        owner_user_id=owner_id,
        source_id=stored.source_id,
        file_name=stored.file_name,
        mime_type=stored.mime_type,
        size_bytes=stored.size_bytes,
        sha256=stored.sha256,
    )
    request = WorkflowRunAdmissionRequest(
        run=WorkflowRun(
            workflow_run_id=uuid4(),
            session_id=session_id,
            owner_user_id=owner_id,
            workflow_type=workflow_type,
            stage=WorkflowStage.COLLECTING_INPUTS,
            stage_version=0,
            status=WorkflowRunStatus.QUEUED,
            created_at=NOW,
            updated_at=NOW,
        ),
        message=WorkflowMessage(
            message_id=uuid4(),
            session_id=session_id,
            author_user_id=owner_id,
            role="user",
            content=message_content,
            client_message_id=uuid4(),
            created_at=NOW,
        ),
        selected_uploads=(snapshot,),
    )
    return (
        workflows,
        SQLiteDraftStore(database),
        SQLiteApprovalStore(database),
        SQLiteActivityEventStore(database),
        files,
        await workflows.admit_run(request),
    )


@pytest.mark.asyncio
async def test_inspection_runner_persists_outputs_events_and_stops_before_export(
    tmp_path: Path,
) -> None:
    workflows, drafts, approvals, events, files, admission = await _admit(
        tmp_path,
        WorkflowType.INSPECTION_ANALYSIS,
        file_name="report.pdf",
        mime_type="application/pdf",
        content=b"%PDF-1.7\nlocal report",
    )
    ai = FakeAIEngine()
    registry = ToolRegistry(cast(Any, approvals), cast(Any, object()), cast(Any, object()))
    runner = CheckpointAwareWorkflowRunner(
        workflows=workflows,
        drafts=drafts,
        approvals=approvals,
        ai_engine=ai,
        tool_registry=registry,
        input_policy=LocalInspectionWorkflowInputPolicy(files),
        events=events,
    )

    await runner.run(admission)

    current = await workflows.get_run(
        workflow_run_id=admission.run.workflow_run_id,
        session_id=admission.run.session_id,
        owner_user_id=admission.run.owner_user_id,
    )
    assert current is not None
    assert current.stage is WorkflowStage.AWAITING_APPROVAL
    assert current.status is WorkflowRunStatus.WAITING_FOR_APPROVAL
    assert (
        await drafts.get_for_run(
            session_id=current.session_id,
            workflow_run_id=current.workflow_run_id,
            owner_user_id=current.owner_user_id,
        )
        is not None
    )
    approval = await approvals.get_for_run(
        session_id=current.session_id,
        workflow_run_id=current.workflow_run_id,
        owner_user_id=current.owner_user_id,
    )
    assert approval is not None and approval.status.value == "pending"
    assert ai.calls[0].startswith("choose_capability:")
    assert any(call.startswith("analyze_visual:") for call in ai.calls)
    assert any(call.startswith("search_knowledge:") for call in ai.calls)
    assert any(call.startswith("create_grounded_draft:") for call in ai.calls)
    replay = await events.replay(
        session_id=current.session_id, owner_user_id=current.owner_user_id, after_event_id=0
    )
    assert [event.event_type for event in replay] == [
        ActivityEventType.MESSAGE_ACCEPTED,
        ActivityEventType.STAGE_CHANGED,
        ActivityEventType.STAGE_CHANGED,
        ActivityEventType.STAGE_CHANGED,
        ActivityEventType.STAGE_CHANGED,
        ActivityEventType.MESSAGE_COMPLETED,
        ActivityEventType.STAGE_CHANGED,
        ActivityEventType.APPROVAL_REQUIRED,
    ]


@pytest.mark.asyncio
async def test_code_repair_creates_only_a_pending_sandbox_approval(tmp_path: Path) -> None:
    workflows, drafts, approvals, events, files, admission = await _admit(
        tmp_path,
        WorkflowType.CODE_REPAIR,
        file_name="validator.py",
        mime_type="text/x-python",
        content=b"print('local')\n",
    )
    upload = admission.selected_uploads[0]
    ai = FakeAIEngine(
        capability_decision=CapabilityDecision(
            capability=Capability.TEXT, selected_model="qwen3:4b", reason="Local code task."
        ),
        action_proposal=AgentProposal(
            tool_call=ProposedToolCall(
                tool_name="run_sandbox",
                arguments={
                    "workspaceId": str(admission.run.session_id),
                    "sourceFileId": str(upload.source_id),
                    "language": "python",
                },
                explanation="Run the local validator only after approval.",
            )
        ),
    )
    registry = ToolRegistry(cast(Any, approvals), cast(Any, object()), cast(Any, object()))
    runner = CheckpointAwareWorkflowRunner(
        workflows=workflows,
        drafts=drafts,
        approvals=approvals,
        ai_engine=ai,
        tool_registry=registry,
        input_policy=LocalInspectionWorkflowInputPolicy(files),
        events=events,
    )

    await runner.run(admission)

    approval = await approvals.get_for_run(
        session_id=admission.run.session_id,
        workflow_run_id=admission.run.workflow_run_id,
        owner_user_id=admission.run.owner_user_id,
    )
    assert approval is not None
    assert approval.tool_name == "run_sandbox"
    assert approval.status.value == "pending"
    assert any(call.startswith("propose_action:") for call in ai.calls)


@pytest.mark.asyncio
async def test_invalid_citation_fails_without_creating_an_approval(tmp_path: Path) -> None:
    workflows, drafts, approvals, events, files, admission = await _admit(
        tmp_path,
        WorkflowType.INSPECTION_ANALYSIS,
        file_name="report.pdf",
        mime_type="application/pdf",
        content=b"%PDF-1.7\nlocal report",
    )
    fake = FakeAIEngine()
    bogus_claim = fake.draft.critical_claims[0].model_copy(
        update={"evidence_source_ids": ("invented-source",)}
    )
    fake.draft = fake.draft.model_copy(
        update={"critical_claims": (bogus_claim,), "evidence_source_ids": ("invented-source",)}
    )
    registry = ToolRegistry(cast(Any, approvals), cast(Any, object()), cast(Any, object()))
    runner = CheckpointAwareWorkflowRunner(
        workflows=workflows,
        drafts=drafts,
        approvals=approvals,
        ai_engine=fake,
        tool_registry=registry,
        input_policy=LocalInspectionWorkflowInputPolicy(files),
        events=events,
    )

    await runner.run(admission)

    current = await workflows.get_run(
        workflow_run_id=admission.run.workflow_run_id,
        session_id=admission.run.session_id,
        owner_user_id=admission.run.owner_user_id,
    )
    assert current is not None and current.status is WorkflowRunStatus.FAILED
    assert (
        await approvals.get_for_run(
            session_id=admission.run.session_id,
            workflow_run_id=admission.run.workflow_run_id,
            owner_user_id=admission.run.owner_user_id,
        )
        is None
    )
    event_types = [
        event.event_type
        for event in await events.replay(
            session_id=admission.run.session_id,
            owner_user_id=admission.run.owner_user_id,
            after_event_id=0,
        )
    ]
    assert ActivityEventType.WORKFLOW_FAILED in event_types


@pytest.mark.asyncio
async def test_code_repair_pending_approval_cannot_invoke_a_phase_five_executor(
    tmp_path: Path,
) -> None:
    """A real code proposal may persist intent but cannot dispatch it in Phase 4."""

    workflows, drafts, approvals, events, files, admission = await _admit(
        tmp_path,
        WorkflowType.CODE_REPAIR,
        file_name="validator.py",
        mime_type="text/x-python",
        content=b"print('local')\n",
    )
    upload = admission.selected_uploads[0]

    class ForbiddenExecutors:
        artifact_calls = 0
        sandbox_calls = 0

        async def create_artifacts(self, request: object) -> object:
            del request
            self.artifact_calls += 1
            raise AssertionError("artifact execution belongs to Phase 5")

        async def run(self, request: object) -> object:
            del request
            self.sandbox_calls += 1
            raise AssertionError("sandbox execution belongs to Phase 5")

    executors = ForbiddenExecutors()
    ai = FakeAIEngine(
        capability_decision=CapabilityDecision(
            capability=Capability.TEXT, selected_model="qwen3:4b", reason="Local code task."
        ),
        action_proposal=AgentProposal(
            tool_call=ProposedToolCall(
                tool_name="run_sandbox",
                arguments={
                    "workspaceId": str(admission.run.session_id),
                    "sourceFileId": str(upload.source_id),
                    "language": "python",
                },
                explanation="Run only after the engineer approves.",
            )
        ),
    )
    runner = CheckpointAwareWorkflowRunner(
        workflows=workflows,
        drafts=drafts,
        approvals=approvals,
        ai_engine=ai,
        tool_registry=ToolRegistry(
            cast(Any, approvals), cast(Any, executors), cast(Any, executors)
        ),
        input_policy=LocalInspectionWorkflowInputPolicy(files),
        events=events,
    )

    await runner.run(admission)

    approval = await approvals.get_for_run(
        session_id=admission.run.session_id,
        workflow_run_id=admission.run.workflow_run_id,
        owner_user_id=admission.run.owner_user_id,
    )
    assert approval is not None and approval.status.value == "pending"
    assert executors.artifact_calls == executors.sandbox_calls == 0


@pytest.mark.asyncio
async def test_restart_recovery_resumes_the_original_durable_user_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Recovery must not replace the original request with a synthetic prompt."""

    original_content = "Repair the selected validator without changing its interface."
    workflows, _, _, _, _, admission = await _admit(
        tmp_path,
        WorkflowType.CODE_REPAIR,
        file_name="validator.py",
        mime_type="text/x-python",
        content=b"print('local')\n",
        message_content=original_content,
    )
    now = datetime.now(UTC)
    active = await workflows.compare_and_set_stage(
        session_id=admission.run.session_id,
        workflow_run_id=admission.run.workflow_run_id,
        owner_user_id=admission.run.owner_user_id,
        expected_stage=WorkflowStage.COLLECTING_INPUTS,
        expected_stage_version=0,
        next_stage=WorkflowStage.PLANNING,
        next_status=WorkflowRunStatus.ACTIVE,
        sandbox_attempts=0,
        lease_expires_at=now - timedelta(hours=1),
    )
    assert active is not None

    class CapturingRecoveryEngine:
        def __init__(self) -> None:
            self.summaries: list[str] = []

        async def choose_capability(self, task: TaskDescriptor) -> CapabilityDecision:
            self.summaries.append(task.summary)
            return CapabilityDecision(
                capability=Capability.TEXT,
                selected_model="qwen3:4b",
                reason="Recovered local code task.",
            )

        async def propose_action(self, request: object) -> AgentProposal:
            del request
            return AgentProposal(response_text="No approval proposal is needed.")

        async def close(self) -> None:
            return None

    engine = CapturingRecoveryEngine()
    monkeypatch.setattr("app.main.create_local_ai_engine", lambda **_: engine)
    settings = ApplicationSettings(
        auth_signing_secret="recovery-test-signing-secret-material-at-least-forty-eight-bytes",
        database_path=tmp_path / "workbench.db",
        sessions_root=tmp_path / "sessions",
        knowledge_root=tmp_path / "knowledge",
    )
    app = create_app(settings=settings, dependencies=compose_runtime_dependencies(settings))

    async with app.router.lifespan_context(app):
        for _ in range(100):
            if engine.summaries:
                break
            await asyncio.sleep(0.01)

    assert engine.summaries == [original_content]
