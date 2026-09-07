"""Phase 4 HTTP admission coverage for asynchronous workflow tasks."""

import asyncio
import time
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pwdlib import PasswordHash

from app.ai.fakes import FakeAIEngine
from app.auth.provisioning import provision_initial_employee
from app.config import ApplicationSettings
from app.health import ApplicationDependencies
from app.main import create_app
from app.ports.local_backend import WorkflowRunAdmission
from app.storage import (
    LocalSessionWorkspaceStore,
    LocalSQLiteDatabase,
    SQLiteActivityEventStore,
    SQLiteApprovalStore,
    SQLiteAuditStore,
    SQLiteAuthSessionStore,
    SQLiteDraftStore,
    SQLiteIdentityStore,
    SQLiteSessionFileStore,
    SQLiteWorkflowStore,
)
from app.tools.registry import ToolRegistry
from app.workflow.contracts import WorkflowRun, WorkflowRunStatus, WorkflowStage
from app.workflow.runner import CheckpointAwareWorkflowRunner, LocalInspectionWorkflowInputPolicy
from app.workflow.supervisor import WorkflowTaskSupervisor

_CAPABILITY = "m" * 43
_ORIGIN = "http://127.0.0.1:5173"
_PASSWORD = "correct horse battery staple"
_SECRET = "workflow-message-test-signing-secret-material-at-least-forty-eight-bytes"


class _SlowRunner:
    def __init__(self) -> None:
        self.admissions: list[WorkflowRunAdmission] = []

    async def run(self, admission: WorkflowRunAdmission) -> None:
        self.admissions.append(admission)
        await asyncio.sleep(0.2)


class _ForbiddenExecutors:
    """Fail loudly if the Phase 4 runner crosses the approval boundary."""

    def __init__(self) -> None:
        self.artifact_calls = 0
        self.sandbox_calls = 0

    async def create_artifacts(self, request: object) -> object:
        del request
        self.artifact_calls += 1
        raise AssertionError("Phase 4 must not create artifacts before approval")

    async def run(self, request: object) -> object:
        del request
        self.sandbox_calls += 1
        raise AssertionError("Phase 4 must not run the sandbox before approval")


async def _provision_second_employee(database_path: Path) -> None:
    database = LocalSQLiteDatabase(database_path)
    async with database.open() as connection:
        await connection.execute("BEGIN IMMEDIATE")
        await connection.execute(
            """INSERT INTO identities
            (user_id, username, display_name, role, password_hash, disabled)
            VALUES (?, ?, ?, ?, ?, 0)""",
            (
                str(uuid4()),
                "engineer.two",
                "Engineer Two",
                "employee",
                PasswordHash.recommended().hash(_PASSWORD),
            ),
        )


def _headers() -> dict[str, str]:
    return {"Origin": _ORIGIN, "x-workbench-capability": _CAPABILITY}


def _build_app(tmp_path: Path) -> tuple[FastAPI, _SlowRunner]:
    database_path = tmp_path / "workbench.db"
    asyncio.run(
        provision_initial_employee(
            database_path=database_path,
            username="engineer.one",
            display_name="Engineer One",
            password=_PASSWORD,
        )
    )
    asyncio.run(_provision_second_employee(database_path))
    database = LocalSQLiteDatabase(database_path)
    workflows = SQLiteWorkflowStore(database)
    runner = _SlowRunner()
    app = create_app(
        settings=ApplicationSettings(
            auth_signing_secret=_SECRET,
            local_service_capability=_CAPABILITY,
            database_path=database_path,
            sessions_root=tmp_path / "sessions",
        ),
        dependencies=ApplicationDependencies(
            identity_store=SQLiteIdentityStore(database),
            auth_session_store=SQLiteAuthSessionStore(database),
            audit_store=SQLiteAuditStore(database),
            workflow_store=workflows,
            session_file_store=SQLiteSessionFileStore(
                database, LocalSessionWorkspaceStore(tmp_path / "sessions")
            ),
            activity_event_store=SQLiteActivityEventStore(database),
            workflow_supervisor=WorkflowTaskSupervisor(runner.run),
            startup=database.initialize,
        ),
    )
    return app, runner


def _build_real_workflow_app(
    tmp_path: Path,
) -> tuple[
    FastAPI,
    SQLiteWorkflowStore,
    SQLiteApprovalStore,
    SQLiteActivityEventStore,
    _ForbiddenExecutors,
]:
    database_path = tmp_path / "workbench.db"
    asyncio.run(
        provision_initial_employee(
            database_path=database_path,
            username="engineer.one",
            display_name="Engineer One",
            password=_PASSWORD,
        )
    )
    database = LocalSQLiteDatabase(database_path)
    workflows = SQLiteWorkflowStore(database)
    files = SQLiteSessionFileStore(database, LocalSessionWorkspaceStore(tmp_path / "sessions"))
    approvals = SQLiteApprovalStore(database)
    events = SQLiteActivityEventStore(database)
    executors = _ForbiddenExecutors()
    runner = CheckpointAwareWorkflowRunner(
        workflows=workflows,
        drafts=SQLiteDraftStore(database),
        approvals=approvals,
        ai_engine=FakeAIEngine(),
        tool_registry=ToolRegistry(
            cast(Any, approvals), cast(Any, executors), cast(Any, executors)
        ),
        input_policy=LocalInspectionWorkflowInputPolicy(files),
        events=events,
    )
    app = create_app(
        settings=ApplicationSettings(
            auth_signing_secret=_SECRET,
            local_service_capability=_CAPABILITY,
            database_path=database_path,
            sessions_root=tmp_path / "sessions",
        ),
        dependencies=ApplicationDependencies(
            identity_store=SQLiteIdentityStore(database),
            auth_session_store=SQLiteAuthSessionStore(database),
            audit_store=SQLiteAuditStore(database),
            workflow_store=workflows,
            session_file_store=files,
            activity_event_store=events,
            workflow_runner=runner,
            workflow_supervisor=WorkflowTaskSupervisor(runner.run),
            startup=database.initialize,
        ),
    )
    return app, workflows, approvals, events, executors


def _wait_for_approval_run(workflows: SQLiteWorkflowStore) -> WorkflowRun:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        runs = asyncio.run(workflows.list_unfinished_runs())
        if runs and runs[0].status is WorkflowRunStatus.WAITING_FOR_APPROVAL:
            return runs[0]
        time.sleep(0.01)
    raise AssertionError("workflow did not reach pending approval")


def _login(client: TestClient, username: str) -> None:
    response = client.post(
        "/auth/login",
        headers=_headers(),
        json={"username": username, "password": _PASSWORD},
    )
    assert response.status_code == 200


def test_message_admission_is_async_idempotent_and_owner_scoped(tmp_path: Path) -> None:
    app, runner = _build_app(tmp_path)
    with TestClient(app) as client:
        _login(client, "engineer.one")
        created = client.post(
            "/sessions",
            headers=_headers(),
            json={"workflowType": "codeRepair", "title": "Validator repair"},
        )
        assert created.status_code == 201
        session_id = created.json()["sessionId"]
        client_message_id = str(uuid4())
        started = time.monotonic()
        accepted = client.post(
            f"/sessions/{session_id}/messages",
            headers=_headers(),
            json={"content": "Review the validator", "clientMessageId": client_message_id},
        )
        elapsed = time.monotonic() - started
        replayed = client.post(
            f"/sessions/{session_id}/messages",
            headers=_headers(),
            json={"content": "Review the validator", "clientMessageId": client_message_id},
        )
        _login(client, "engineer.two")
        foreign = client.post(
            f"/sessions/{session_id}/messages",
            headers=_headers(),
            json={"content": "Not my session", "clientMessageId": str(uuid4())},
        )
        time.sleep(0.05)

    assert elapsed < 0.15
    assert accepted.status_code == replayed.status_code == 202
    assert accepted.json() == replayed.json()
    assert accepted.json()["status"] == "queued"
    assert accepted.json()["eventsUrl"] == f"/sessions/{session_id}/events"
    assert foreign.status_code == 404
    assert len(runner.admissions) == 1


def test_inspection_message_requires_selected_owned_upload(tmp_path: Path) -> None:
    app, _ = _build_app(tmp_path)
    with TestClient(app) as client:
        _login(client, "engineer.one")
        created = client.post(
            "/sessions",
            headers=_headers(),
            json={"workflowType": "inspectionAnalysis", "title": "Inspection"},
        )
        session_id = created.json()["sessionId"]
        missing = client.post(
            f"/sessions/{session_id}/messages",
            headers=_headers(),
            json={"content": "Inspect", "clientMessageId": str(uuid4())},
        )
        foreign_upload = client.post(
            f"/sessions/{session_id}/messages",
            headers=_headers(),
            json={
                "content": "Inspect",
                "clientMessageId": str(uuid4()),
                "selectedUploadIds": [str(uuid4())],
            },
        )

    assert missing.status_code == 422
    assert missing.json()["code"] == "inspection_input_required"
    assert foreign_upload.status_code == 404
    assert foreign_upload.json()["code"] == "upload_not_found"


def test_authenticated_inspection_admission_replays_after_durable_approval(
    tmp_path: Path,
) -> None:
    """Exercise the real HTTP-to-runner path and its completed retry behavior."""

    app, workflows, approvals, events, executors = _build_real_workflow_app(tmp_path)
    with TestClient(app) as client:
        _login(client, "engineer.one")
        created = client.post(
            "/sessions",
            headers=_headers(),
            json={"workflowType": "inspectionAnalysis", "title": "Inspection"},
        )
        assert created.status_code == 201
        session_id = created.json()["sessionId"]
        uploaded = client.post(
            f"/sessions/{session_id}/uploads",
            headers=_headers(),
            files={"file": ("report.pdf", b"%PDF-1.7\nlocal report", "application/pdf")},
        )
        assert uploaded.status_code == 201
        client_message_id = str(uuid4())
        payload = {
            "content": "Prepare the inspection approval note.",
            "clientMessageId": client_message_id,
            "selectedUploadIds": [uploaded.json()["uploadId"]],
        }
        accepted = client.post(f"/sessions/{session_id}/messages", headers=_headers(), json=payload)
        assert accepted.status_code == 202
        run = _wait_for_approval_run(workflows)
        replayed = client.post(f"/sessions/{session_id}/messages", headers=_headers(), json=payload)

    assert replayed.status_code == 202
    assert replayed.json() == accepted.json()
    assert run.stage is WorkflowStage.AWAITING_APPROVAL
    approval = asyncio.run(
        approvals.get_for_run(
            session_id=run.session_id,
            workflow_run_id=run.workflow_run_id,
            owner_user_id=run.owner_user_id,
        )
    )
    assert approval is not None and approval.tool_name == "request_document_export"
    messages = asyncio.run(workflows.list_messages(run.session_id, run.owner_user_id))
    assert [message.role for message in messages] == ["user", "assistant"]
    replay = asyncio.run(
        events.replay(session_id=run.session_id, owner_user_id=run.owner_user_id, after_event_id=0)
    )
    assert replay[-1].event_type.value == "approval.required"
    assert executors.artifact_calls == executors.sandbox_calls == 0
