"""Small in-process supervision for durable workflow runs."""

import asyncio
import contextlib
from collections.abc import Callable, Coroutine

from app.ports.local_backend import WorkflowRunAdmission

WorkflowTask = Callable[[WorkflowRunAdmission], Coroutine[object, object, None]]


class WorkflowTaskSupervisor:
    """Own background tasks without introducing an external queue.

    Durable admission happens before a task is submitted. Consequently a
    process loss leaves a recoverable run in SQLite even if the task never
    gets CPU time. The composition root handles restart recovery from that
    durable admission record.
    """

    def __init__(self, run_workflow: WorkflowTask) -> None:
        self._run_workflow = run_workflow
        self._tasks: set[asyncio.Task[None]] = set()
        self._stopping = False

    def submit(self, admission: WorkflowRunAdmission) -> None:
        """Start an admitted run and return immediately to the HTTP route."""

        if self._stopping:
            raise RuntimeError("workflow supervisor is stopping")
        task: asyncio.Task[None] = asyncio.create_task(
            self._run_workflow(admission), name=f"workflow-{admission.run.workflow_run_id}"
        )
        self._tasks.add(task)
        task.add_done_callback(self._discard)

    def _discard(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        with contextlib.suppress(asyncio.CancelledError, Exception):
            task.result()

    async def shutdown(self, *, timeout_seconds: float = 5.0) -> None:
        """Bound graceful shutdown; unfinished leased runs recover on restart."""

        self._stopping = True
        if not self._tasks:
            return
        done, pending = await asyncio.wait(self._tasks, timeout=timeout_seconds)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        # Read task exceptions so asyncio does not emit an unhandled-task warning.
        for task in done:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                task.result()
