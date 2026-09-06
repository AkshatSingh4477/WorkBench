import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ChatSession } from "../src/shared/contracts.ts";
import {
  appendedMessageWasDelivered,
  chatSessionTitleFromDraft,
  chatStageSteps,
  chatThreadReducer,
  chatThreadFromSession,
  threadHasUnsentContent,
  type ChatThread,
  type ChatThreadId,
  type ChatThreadState,
} from "../src/renderer/lib/chatThreads.ts";

function thread(id: string, updatedAt: number, createdAt = 0): ChatThread {
  return {
    id: id as ChatThreadId, title: id, source: "local", workflowType: "inspectionAnalysis",
    draft: "", attachments: [], inspectionFiles: {},
    messages: [], messagesState: "idle", sendState: "idle",
    createdAt, updatedAt,
  };
}

function stateOf(threads: readonly ChatThread[], activeThreadId: ChatThreadId, sessionsState: ChatThreadState["sessionsState"] = "ready"): ChatThreadState {
  return { threads, activeThreadId, sessionsState };
}

function session(sessionId: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId,
    ownerUserId: "00000000-0000-4000-8000-000000000000",
    workflowType: "inspectionAnalysis",
    title: "Report review",
    stage: "collectingInputs",
    status: "active",
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:05:00Z",
    ...overrides,
  };
}

function message(content: string, createdAt = "2026-09-01T10:06:00Z"): ChatMessage {
  return {
    messageId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    authorUserId: null,
    role: "user",
    content,
    createdAt,
  };
}

test("edits preserve ordering, other drafts, and the selected chat", () => {
  const first = thread("first", 30);
  const second = thread("second", 20);
  const third = thread("third", 10);
  const state = stateOf([first, second, third], first.id);
  const result = chatThreadReducer(state, { type: "updateDraft", threadId: third.id, draft: "Review", now: 40 });
  assert.deepEqual(result.threads.map(({ id }) => id), [third.id, first.id, second.id]);
  assert.equal(result.activeThreadId, first.id);
  assert.equal(result.threads[0]?.draft, "Review");
  assert.equal(result.threads[1], first);
  assert.equal(state.threads[2]?.draft, "");
  assert.equal(chatThreadReducer(result, { type: "updateDraft", threadId: third.id, draft: "Review", now: 50 }), result);
});

test("clock rollback and equal timestamps retain deterministic order", () => {
  const first = thread("a", 30, 3);
  const second = thread("b", 20, 2);
  const third = thread("c", 20, 2);
  const state = stateOf([first, second, third], first.id);
  const rolledBack = chatThreadReducer(state, { type: "updateDraft", threadId: first.id, draft: "Rollback", now: 10 });
  assert.deepEqual(rolledBack.threads.map(({ id }) => id), [second.id, third.id, first.id]);
  const tied = chatThreadReducer(state, { type: "updateDraft", threadId: third.id, draft: "Tie", now: 20 });
  assert.deepEqual(tied.threads.map(({ id }) => id), [first.id, second.id, third.id]);
});

test("new chat reuses an empty draft without replacing another chat's files", () => {
  const first = thread("first", 30);
  const state = stateOf([first], first.id);
  const created = chatThreadReducer(state, { type: "create", threadId: "new" as ChatThreadId, now: 40 });
  const reused = chatThreadReducer(created, { type: "create", threadId: "unused" as ChatThreadId, now: 50 });
  assert.equal(reused.threads.length, 2);
  assert.equal(reused.activeThreadId, "new");
  const withFile = chatThreadReducer(reused, {
    type: "setInspectionFile", threadId: first.id, kind: "inspectionReport", now: 60,
    file: { name: "report.pdf", kind: "inspectionReport", mimeType: "application/pdf", sizeBytes: 42 },
  });
  assert.equal(withFile.threads[0]?.inspectionFiles.inspectionReport?.name, "report.pdf");
  assert.deepEqual(withFile.threads[1]?.inspectionFiles, {});
});

test("a bound thread is no longer reusable as an empty new chat", () => {
  const bound = { ...thread("bound", 30), title: "New chat", sessionId: "33333333-3333-4333-8333-333333333333" };
  const state = stateOf([bound], bound.id);
  const created = chatThreadReducer(state, { type: "create", threadId: "new" as ChatThreadId, now: 40 });
  assert.equal(created.threads.length, 2);
  assert.equal(created.activeThreadId, "new");
});

test("loaded sessions replace pristine local threads and map backend fields", () => {
  const pristine = thread("pristine", 30);
  const state = stateOf([pristine], pristine.id, "loading");
  const result = chatThreadReducer(state, {
    type: "sessionsLoaded", freshThreadId: "fresh" as ChatThreadId, now: 40,
    sessions: [session("44444444-4444-4444-8444-444444444444", { stage: "retrieving" })],
  });
  assert.equal(result.sessionsState, "ready");
  assert.equal(result.threads.length, 1);
  const loaded = result.threads[0]!;
  assert.equal(loaded.id, "chat-44444444-4444-4444-8444-444444444444");
  assert.equal(loaded.sessionId, "44444444-4444-4444-8444-444444444444");
  assert.equal(loaded.title, "Report review");
  assert.equal(loaded.stage, "retrieving");
  assert.equal(loaded.status, "active");
  assert.equal(loaded.messagesState, "idle");
  assert.equal(loaded.updatedAt, Date.parse("2026-09-01T10:05:00Z"));
  assert.equal(result.activeThreadId, loaded.id);
});

test("loaded sessions preserve local threads that still hold unsent content", () => {
  const dirty = { ...thread("dirty", 35), draft: "Unsent note" };
  const state = stateOf([dirty], dirty.id, "loading");
  const result = chatThreadReducer(state, {
    type: "sessionsLoaded", freshThreadId: "fresh" as ChatThreadId, now: 40,
    sessions: [session("44444444-4444-4444-8444-444444444444")],
  });
  assert.equal(result.threads.length, 2);
  assert.equal(result.threads.find((candidate) => candidate.id === dirty.id)?.draft, "Unsent note");
  assert.equal(result.activeThreadId, dirty.id);
});

test("loaded sessions with an empty list seed one fresh local chat", () => {
  const pristine = thread("pristine", 30);
  const state = stateOf([pristine], pristine.id, "loading");
  const result = chatThreadReducer(state, {
    type: "sessionsLoaded", freshThreadId: "fresh" as ChatThreadId, now: 40, sessions: [],
  });
  assert.equal(result.sessionsState, "ready");
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0]?.id, "fresh");
  assert.equal(result.threads[0]?.title, "New chat");
  assert.equal(result.activeThreadId, "fresh");
});

test("loaded sessions keep the example thread and activate the selection", () => {
  const example: ChatThread = { ...thread("example-inspection-report-review", 50), source: "example" };
  const state = stateOf([example], example.id, "loading");
  const result = chatThreadReducer(state, {
    type: "sessionsLoaded", freshThreadId: "fresh" as ChatThreadId, now: 40,
    sessions: [session("44444444-4444-4444-8444-444444444444")],
  });
  assert.equal(result.threads.length, 2);
  assert.ok(result.threads.some((candidate) => candidate.source === "example"));
  assert.equal(result.activeThreadId, example.id);
});

test("message append completes a send and reorders by activity", () => {
  const bound = { ...thread("bound", 30), sessionId: "33333333-3333-4333-8333-333333333333", sendState: "sending" as const };
  const newer = thread("newer", 60);
  const state = stateOf([newer, bound], bound.id);
  const result = chatThreadReducer(state, {
    type: "messageAppended", threadId: bound.id, message: message("Extract finding one"), now: 70,
  });
  assert.deepEqual(result.threads.map(({ id }) => id), [bound.id, newer.id]);
  const sent = result.threads[0]!;
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.messages[0]?.content, "Extract finding one");
  assert.equal(sent.messagesState, "ready");
  assert.equal(sent.sendState, "idle");
});

test("session sync and failure paths update only the targeted thread", () => {
  const bound = { ...thread("bound", 30), sessionId: "33333333-3333-4333-8333-333333333333", stage: "extracting" as const };
  const other = thread("other", 20);
  const state = stateOf([bound, other], bound.id);

  const started = chatThreadReducer(state, { type: "sendStarted", threadId: bound.id });
  assert.equal(started.threads[0]?.sendState, "sending");

  const synced = chatThreadReducer(started, {
    type: "sessionSynced", threadId: bound.id,
    session: session("33333333-3333-4333-8333-333333333333", { stage: "drafting", updatedAt: "2026-09-01T10:07:00Z" }),
  });
  assert.equal(synced.threads[0]?.stage, "drafting");
  assert.equal(synced.threads[0]?.status, "active");
  assert.equal(synced.threads[1], other);

  const failed = chatThreadReducer(started, { type: "sendFailed", threadId: bound.id, message: "FastAPI is unavailable. The message was not sent." });
  assert.equal(failed.threads[0]?.sendState, "error");
  assert.equal(failed.threads[0]?.sendError, "FastAPI is unavailable. The message was not sent.");
  assert.equal(failed.threads[1], other);

  const cleared = chatThreadReducer(failed, { type: "sendStarted", threadId: bound.id });
  assert.equal(cleared.threads[0]?.sendState, "sending");
  assert.equal(cleared.threads[0]?.sendError, undefined);
  assert.equal(chatThreadReducer(cleared, { type: "sendFailed", threadId: "unknown" as ChatThreadId, message: "ignored" }), cleared);
});

test("message loads transition idle, loading, ready, and error without touching other threads", () => {
  const bound = { ...thread("bound", 30), sessionId: "33333333-3333-4333-8333-333333333333" };
  const other = thread("other", 20);
  const state = stateOf([bound, other], bound.id);

  const loading = chatThreadReducer(state, { type: "messagesLoading", threadId: bound.id });
  assert.equal(loading.threads[0]?.messagesState, "loading");
  assert.equal(chatThreadReducer(loading, { type: "messagesLoading", threadId: bound.id }), loading);

  const loaded = chatThreadReducer(loading, { type: "messagesLoaded", threadId: bound.id, messages: [message("Stored message")] });
  assert.equal(loaded.threads[0]?.messagesState, "ready");
  assert.equal(loaded.threads[0]?.messages.length, 1);

  const retryLoad = chatThreadReducer(loaded, { type: "messagesLoading", threadId: bound.id });
  const errored = chatThreadReducer(retryLoad, { type: "messagesFailed", threadId: bound.id });
  assert.equal(errored.threads[0]?.messagesState, "error");
  assert.equal(errored.threads[1], other);

  const failedOutsideLoad = chatThreadReducer(loaded, { type: "messagesFailed", threadId: bound.id });
  assert.equal(failedOutsideLoad.threads[0]?.messagesState, "ready");
  assert.equal(chatThreadReducer(state, { type: "messagesLoaded", threadId: "unknown" as ChatThreadId, messages: [] }), state);
});

test("session binding adopts the backend title only for a new chat", () => {
  const fresh = thread("local-1", 30);
  fresh.title = "New chat";
  const renamed = { ...thread("local-2", 20), title: "Pump 4 seal review" };
  const state = stateOf([fresh, renamed], fresh.id);

  const boundFresh = chatThreadReducer(state, {
    type: "sessionBound", threadId: fresh.id,
    session: session("33333333-3333-4333-8333-333333333333", { title: "Pump 4 seal review" }),
  });
  assert.equal(boundFresh.threads.find((candidate) => candidate.id === fresh.id)?.title, "Pump 4 seal review");
  assert.equal(boundFresh.threads.find((candidate) => candidate.id === fresh.id)?.sessionId, "33333333-3333-4333-8333-333333333333");

  const boundRenamed = chatThreadReducer(state, {
    type: "sessionBound", threadId: renamed.id,
    session: session("44444444-4444-4444-8444-444444444444", { title: "Backend title" }),
  });
  assert.equal(boundRenamed.threads.find((candidate) => candidate.id === renamed.id)?.title, "Pump 4 seal review");
});

test("draft clearing keeps unrelated drafts", () => {
  const first = { ...thread("first", 30), draft: "Send me" };
  const second = { ...thread("second", 20), draft: "Keep me" };
  const state = stateOf([first, second], first.id);
  const result = chatThreadReducer(state, { type: "draftCleared", threadId: first.id, now: 40 });
  assert.equal(result.threads[0]?.draft, "");
  assert.equal(result.threads[1]?.draft, "Keep me");
  assert.equal(chatThreadReducer(result, { type: "draftCleared", threadId: first.id, now: 50 }), result);
});

test("session titles derive from the first draft line without splitting mid-word content", () => {
  assert.equal(chatSessionTitleFromDraft("Review pump 4\nsecond line"), "Review pump 4");
  assert.equal(chatSessionTitleFromDraft("   \n  "), "Inspection review");
  assert.equal(chatSessionTitleFromDraft("  Packed   spaces  here  "), "Packed spaces here");
  const long = "A".repeat(120);
  assert.equal(chatSessionTitleFromDraft(long), `${"A".repeat(80)}…`);
});

test("unsent-content detection drives preservation", () => {
  assert.equal(threadHasUnsentContent(thread("empty", 10)), false);
  assert.equal(threadHasUnsentContent({ ...thread("draft", 10), draft: " note " }), true);
  assert.equal(threadHasUnsentContent({ ...thread("attached", 10), attachments: [{ name: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 }] }), true);
  assert.equal(threadHasUnsentContent({ ...thread("report", 10), inspectionFiles: { inspectionReport: { name: "r.pdf", kind: "inspectionReport", mimeType: "application/pdf", sizeBytes: 1 } } }), true);
});

test("chatThreadFromSession maps the wire contract onto a thread", () => {
  const mapped = chatThreadFromSession(session("44444444-4444-4444-8444-444444444444", {
    workflowType: "codeRepair", stage: "planning", title: "Code repair task",
  }));
  assert.equal(mapped.id, "chat-44444444-4444-4444-8444-444444444444");
  assert.equal(mapped.workflowType, "codeRepair");
  assert.equal(mapped.stage, "planning");
  assert.equal(mapped.source, "local");
  assert.deepEqual(mapped.messages, []);
});

test("session refresh merges into bound threads without discarding local state", () => {
  const bound: ChatThread = {
    ...thread("local-1", 30),
    sessionId: "44444444-4444-4444-8444-444444444444",
    title: "Pump 4 seal review",
    draft: "Unsent follow-up",
    attachments: [{ name: "photo.png", mimeType: "image/png", sizeBytes: 9 }],
    messages: [message("Earlier message")],
    messagesState: "ready",
    sendState: "sending",
    stage: "collectingInputs",
  };
  const pristine = thread("pristine", 25);
  const state = stateOf([bound, pristine], bound.id, "loading");
  const result = chatThreadReducer(state, {
    type: "sessionsLoaded", freshThreadId: "fresh" as ChatThreadId, now: 40,
    sessions: [session("44444444-4444-4444-8444-444444444444", { stage: "retrieving" })],
  });
  assert.equal(result.threads.length, 1);
  const merged = result.threads[0]!;
  assert.equal(merged.id, "local-1");
  assert.equal(merged.draft, "Unsent follow-up");
  assert.equal(merged.attachments.length, 1);
  assert.equal(merged.messages.length, 1);
  assert.equal(merged.messagesState, "ready");
  assert.equal(merged.sendState, "sending");
  assert.equal(merged.stage, "retrieving");
  assert.equal(merged.status, "active");
  assert.equal(merged.title, "Pump 4 seal review");
  assert.equal(merged.updatedAt, Date.parse("2026-09-01T10:05:00Z"));
  assert.equal(result.activeThreadId, "local-1");
});

test("session refresh adopts the backend title only for an unrenamed new chat", () => {
  const unnamed = { ...thread("local-1", 30), title: "New chat", sessionId: "44444444-4444-4444-8444-444444444444" };
  const state = stateOf([unnamed], unnamed.id, "loading");
  const result = chatThreadReducer(state, {
    type: "sessionsLoaded", freshThreadId: "fresh" as ChatThreadId, now: 40,
    sessions: [session("44444444-4444-4444-8444-444444444444", { title: "Backend title" })],
  });
  assert.equal(result.threads[0]?.title, "Backend title");
});

test("session refresh drops bound threads the backend no longer returns", () => {
  const stale = { ...thread("stale", 30), sessionId: "55555555-5555-4555-8555-555555555555" };
  const state = stateOf([stale], stale.id, "loading");
  const result = chatThreadReducer(state, {
    type: "sessionsLoaded", freshThreadId: "fresh" as ChatThreadId, now: 40,
    sessions: [session("44444444-4444-4444-8444-444444444444")],
  });
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0]?.sessionId, "44444444-4444-4444-8444-444444444444");
  assert.equal(result.activeThreadId, "chat-44444444-4444-4444-8444-444444444444");
});

test("ambiguous appends count as delivered only for unseen employee content", () => {
  const stored = [message("Pump 4 seal shows scoring"), message("Second note")];
  assert.equal(appendedMessageWasDelivered([], stored, "Pump 4 seal shows scoring"), true);
  assert.equal(appendedMessageWasDelivered([stored[0]!], stored, "Pump 4 seal shows scoring"), false);
  assert.equal(
    appendedMessageWasDelivered([], [{ ...stored[0]!, role: "assistant" }], "Pump 4 seal shows scoring"),
    false,
  );
  assert.equal(appendedMessageWasDelivered([], stored, "Never stored"), false);
});

test("send resolution clears an ambiguous failure exactly once", () => {
  const first = { ...thread("first", 30), draft: "Ambiguous send", sendState: "sending" as const };
  const state = stateOf([first], first.id);
  const failed = chatThreadReducer(state, { type: "sendFailed", threadId: first.id, message: "The local service timed out. The message was not sent." });
  const resolved = chatThreadReducer(failed, { type: "sendResolved", threadId: first.id, now: 40 });
  assert.equal(resolved.threads[0]?.sendState, "idle");
  assert.equal(resolved.threads[0]?.sendError, undefined);
  assert.equal(resolved.threads[0]?.draft, "Ambiguous send");
  assert.equal(chatThreadReducer(resolved, { type: "sendResolved", threadId: first.id, now: 50 }), resolved);
});

test("stage pipelines reflect active, failed, and terminal states", () => {
  const active = chatStageSteps("inspectionAnalysis", "retrieving", "active");
  assert.deepEqual(active.map((step) => step.state), ["done", "done", "active", "queued", "queued", "queued", "queued"]);
  assert.deepEqual(active.map((step) => step.stage), [
    "collectingInputs", "extracting", "retrieving", "drafting", "validating", "awaitingApproval", "exporting",
  ]);

  const failed = chatStageSteps("inspectionAnalysis", "extracting", "failed");
  assert.deepEqual(failed.map((step) => step.state), ["done", "failed", "queued", "queued", "queued", "queued", "queued"]);

  const codeRepair = chatStageSteps("codeRepair", "sandboxExecuting", "active");
  assert.deepEqual(codeRepair.map((step) => step.stage), [
    "collectingInputs", "planning", "awaitingApproval", "sandboxExecuting", "repairing",
  ]);
  assert.deepEqual(codeRepair.map((step) => step.state), ["done", "done", "done", "active", "queued"]);

  assert.deepEqual(chatStageSteps("inspectionAnalysis", "completed", "completed"), []);
  assert.deepEqual(chatStageSteps("inspectionAnalysis", "approvalRejected", "approvalRejected"), []);
  assert.deepEqual(chatStageSteps("inspectionAnalysis", "collectingInputs", "active"), [
    { stage: "collectingInputs", state: "active" },
    { stage: "extracting", state: "queued" },
    { stage: "retrieving", state: "queued" },
    { stage: "drafting", state: "queued" },
    { stage: "validating", state: "queued" },
    { stage: "awaitingApproval", state: "queued" },
    { stage: "exporting", state: "queued" },
  ]);
});
