import type {
  ChatMessage,
  ChatSession,
  ChatSessionStatus,
  ChatStage,
  ChatWorkflowType,
  SelectedChatAttachment,
  SelectedUploadFile,
  UploadKind,
} from "../../shared/contracts";

export type ChatThreadId = string & { readonly __chatThreadId: unique symbol };
export type ChatThreadSource = "example" | "local";
export type ChatSessionsState = "idle" | "loading" | "ready" | "error";
export type ChatMessagesState = "idle" | "loading" | "ready" | "error";
export type ChatSendState = "idle" | "sending" | "error";

interface ChatThreadFields {
  id: ChatThreadId;
  title: string;
  draft: string;
  attachments: readonly SelectedChatAttachment[];
  inspectionFiles: Partial<Record<UploadKind, SelectedUploadFile>>;
  createdAt: number;
  updatedAt: number;
  /** Backend workflow session; absent until FastAPI accepts this thread. */
  sessionId?: string;
  workflowType: ChatWorkflowType;
  stage?: ChatStage;
  status?: ChatSessionStatus;
  messages: readonly ChatMessage[];
  messagesState: ChatMessagesState;
  sendState: ChatSendState;
  sendError?: string;
}

export interface LocalChatThread extends ChatThreadFields {
  source: "local";
}

export interface ExampleChatThread extends ChatThreadFields {
  source: "example";
}

export type ChatThread = LocalChatThread | ExampleChatThread;

export interface ChatThreadState {
  threads: readonly ChatThread[];
  activeThreadId: ChatThreadId;
  sessionsState: ChatSessionsState;
}

export type ChatThreadAction =
  | { type: "select"; threadId: ChatThreadId }
  | { type: "create"; threadId: ChatThreadId; now: number }
  | { type: "updateDraft"; threadId: ChatThreadId; draft: string; now: number }
  | { type: "replaceAttachments"; threadId: ChatThreadId; attachments: readonly SelectedChatAttachment[]; now: number }
  | { type: "setInspectionFile"; threadId: ChatThreadId; file?: SelectedUploadFile; kind: UploadKind; now: number }
  | { type: "sessionsLoading" }
  | { type: "sessionsLoaded"; freshThreadId: ChatThreadId; now: number; sessions: readonly ChatSession[] }
  | { type: "sessionsFailed" }
  | { type: "messagesLoading"; threadId: ChatThreadId }
  | { type: "messagesLoaded"; threadId: ChatThreadId; messages: readonly ChatMessage[] }
  | { type: "messagesFailed"; threadId: ChatThreadId }
  | { type: "sessionBound"; threadId: ChatThreadId; session: ChatSession }
  | { type: "messageAppended"; threadId: ChatThreadId; message: ChatMessage; now: number }
  | { type: "sessionSynced"; threadId: ChatThreadId; session: ChatSession }
  | { type: "sendStarted"; threadId: ChatThreadId }
  | { type: "sendFailed"; threadId: ChatThreadId; message: string }
  | { type: "sendResolved"; threadId: ChatThreadId; now: number }
  | { type: "draftCleared"; threadId: ChatThreadId; now: number };

let localThreadSequence = 0;

export function createThreadId(): ChatThreadId {
  localThreadSequence += 1;
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${localThreadSequence}`;
  return `local-chat-${randomId}` as ChatThreadId;
}

/** The renderer may build identifiers only from server-issued session IDs. */
export function chatThreadIdForSession(sessionId: string): ChatThreadId {
  return `chat-${sessionId}` as ChatThreadId;
}

export function chatThreadFromSession(session: ChatSession): LocalChatThread {
  return {
    id: chatThreadIdForSession(session.sessionId),
    sessionId: session.sessionId,
    title: session.title,
    source: "local",
    workflowType: session.workflowType,
    stage: session.stage,
    status: session.status,
    draft: "",
    attachments: [],
    inspectionFiles: {},
    messages: [],
    messagesState: "idle",
    sendState: "idle",
    createdAt: Date.parse(session.createdAt),
    updatedAt: Date.parse(session.updatedAt),
  };
}

/** A local thread with unsent content survives a session refresh; a pristine one does not. */
export function threadHasUnsentContent(thread: ChatThread): boolean {
  return (
    thread.draft.trim().length > 0 ||
    thread.attachments.length > 0 ||
    thread.inspectionFiles.inspectionReport !== undefined ||
    thread.inspectionFiles.sitePhotograph !== undefined
  );
}

/** Derive the backend session title from the first non-blank draft line. */
export function chatSessionTitleFromDraft(draft: string): string {
  const firstLine = draft.trim().split(/\r?\n/, 1)[0] ?? "";
  const condensed = firstLine.replace(/\s+/g, " ").trim();
  if (condensed.length === 0) return "Inspection review";
  return condensed.length > 80 ? `${condensed.slice(0, 80).trimEnd()}…` : condensed;
}

function isEmptyNewChat(thread: ChatThread): boolean {
  return (
    thread.source === "local" &&
    thread.sessionId === undefined &&
    thread.title === "New chat" &&
    !threadHasUnsentContent(thread)
  );
}

function orderThreads(threads: readonly ChatThread[]): readonly ChatThread[] {
  return [...threads].sort(compareThreads);
}

function compareThreads(left: ChatThread, right: ChatThread): number {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id);
}

function updateThread(
  state: ChatThreadState,
  threadId: ChatThreadId,
  update: (thread: ChatThread) => ChatThread,
): ChatThreadState {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) return state;

  const updatedThread = update(thread);
  if (updatedThread === thread) return state;

  // Only one thread changed. The rest are already sorted, including when the
  // clock moves backwards or several updates share the same timestamp.
  const threads = state.threads.filter((candidate) => candidate.id !== threadId);
  const insertionIndex = threads.findIndex((candidate) => compareThreads(updatedThread, candidate) < 0);
  threads.splice(insertionIndex === -1 ? threads.length : insertionIndex, 0, updatedThread);
  return { ...state, threads };
}

function replaceThreads(state: ChatThreadState, threads: readonly ChatThread[]): ChatThreadState {
  const activeThread = threads.find((thread) => thread.id === state.activeThreadId);
  if (activeThread) return { ...state, threads, sessionsState: "ready" };
  const fallback = threads[0];
  if (!fallback) return state;
  return { ...state, threads, activeThreadId: fallback.id, sessionsState: "ready" };
}

/**
 * Refresh a bound thread from backend state without discarding local state:
 * the identifier stays stable so in-flight callbacks keep targeting this
 * thread, and drafts, files, messages, and send state survive the refresh.
 */
export function mergeBackendThread(existing: ChatThread, backend: LocalChatThread): ChatThread {
  return {
    ...backend,
    id: existing.id,
    title: existing.title === "New chat" ? backend.title : existing.title,
    draft: existing.draft,
    attachments: existing.attachments,
    inspectionFiles: existing.inspectionFiles,
    messages: existing.messages,
    messagesState: existing.messagesState,
    sendState: existing.sendState,
    sendError: existing.sendError,
  };
}

/**
 * An ambiguous append failure counts as delivered only when the stored list
 * contains an exact employee message that the pre-send snapshot did not have.
 */
export function appendedMessageWasDelivered(
  snapshot: readonly ChatMessage[],
  stored: readonly ChatMessage[],
  content: string,
): boolean {
  const snapshotIds = new Set(snapshot.map((message) => message.messageId));
  return stored.some(
    (message) => message.role === "user" && message.content === content && !snapshotIds.has(message.messageId),
  );
}

export function chatThreadReducer(state: ChatThreadState, action: ChatThreadAction): ChatThreadState {
  switch (action.type) {
    case "select":
      return state.threads.some((thread) => thread.id === action.threadId)
        ? { ...state, activeThreadId: action.threadId }
        : state;
    case "create": {
      const emptyThread = state.threads.find(isEmptyNewChat);
      if (emptyThread) return { ...state, activeThreadId: emptyThread.id };

      const thread = createLocalChatThread(action.threadId, action.now);
      return { threads: orderThreads([thread, ...state.threads]), activeThreadId: thread.id, sessionsState: state.sessionsState };
    }
    case "updateDraft":
      return updateThread(state, action.threadId, (thread) =>
        thread.draft === action.draft ? thread : { ...thread, draft: action.draft, updatedAt: action.now },
      );
    case "replaceAttachments":
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        attachments: action.attachments,
        updatedAt: action.now,
      }));
    case "setInspectionFile":
      return updateThread(state, action.threadId, (thread) => {
        if (thread.inspectionFiles[action.kind] === action.file) return thread;
        return {
          ...thread,
          inspectionFiles: { ...thread.inspectionFiles, [action.kind]: action.file },
          updatedAt: action.now,
        };
      });
    case "sessionsLoading":
      return state.sessionsState === "loading" ? state : { ...state, sessionsState: "loading" };
    case "sessionsLoaded": {
      // Backend sessions are the truth for stage and status. Existing threads
      // merge by session ID so unsent content and history survive a refresh.
      const backendThreads = action.sessions.map(chatThreadFromSession);
      const backendBySessionId = new Map(backendThreads.map((thread) => [thread.sessionId, thread]));
      const keptThreads: ChatThread[] = [];
      for (const existing of state.threads) {
        if (existing.source === "example") {
          keptThreads.push(existing);
          continue;
        }
        const backend =
          existing.sessionId === undefined ? undefined : backendBySessionId.get(existing.sessionId);
        if (backend) {
          backendBySessionId.delete(backend.sessionId);
          keptThreads.push(mergeBackendThread(existing, backend));
          continue;
        }
        if (existing.sessionId === undefined && threadHasUnsentContent(existing)) {
          keptThreads.push(existing);
        }
        // Stale bound threads and pristine empty threads drop out of the list.
      }
      const merged = orderThreads([...keptThreads, ...backendBySessionId.values()]);
      if (merged.length === 0) {
        const freshThread = createLocalChatThread(action.freshThreadId, action.now);
        return { threads: [freshThread], activeThreadId: freshThread.id, sessionsState: "ready" };
      }
      return replaceThreads(state, merged);
    }
    case "sessionsFailed":
      return { ...state, sessionsState: "error" };
    case "messagesLoading":
      return updateThread(state, action.threadId, (thread) =>
        thread.messagesState === "loading" ? thread : { ...thread, messagesState: "loading" },
      );
    case "messagesLoaded":
      return updateThread(state, action.threadId, (thread) => ({ ...thread, messages: action.messages, messagesState: "ready" }));
    case "messagesFailed":
      return updateThread(state, action.threadId, (thread) =>
        thread.messagesState === "loading" ? { ...thread, messagesState: "error" } : thread,
      );
    case "sessionBound":
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        sessionId: action.session.sessionId,
        stage: action.session.stage,
        status: action.session.status,
        title: thread.title === "New chat" ? action.session.title : thread.title,
        updatedAt: Date.parse(action.session.updatedAt),
      }));
    case "messageAppended":
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        messages: [...thread.messages, action.message],
        messagesState: "ready",
        sendState: "idle",
        updatedAt: action.now,
      }));
    case "sessionSynced":
      return updateThread(state, action.threadId, (thread) => ({
        ...thread,
        stage: action.session.stage,
        status: action.session.status,
        updatedAt: Date.parse(action.session.updatedAt),
      }));
    case "sendStarted":
      return updateThread(state, action.threadId, (thread) =>
        thread.sendState === "sending" ? thread : { ...thread, sendState: "sending", sendError: undefined },
      );
    case "sendFailed":
      return updateThread(state, action.threadId, (thread) => ({ ...thread, sendState: "error", sendError: action.message }));
    case "sendResolved":
      return updateThread(state, action.threadId, (thread) =>
        thread.sendState === "idle" && thread.sendError === undefined
          ? thread
          : { ...thread, sendState: "idle", sendError: undefined, updatedAt: action.now },
      );
    case "draftCleared":
      return updateThread(state, action.threadId, (thread) =>
        thread.draft.length === 0 ? thread : { ...thread, draft: "", updatedAt: action.now },
      );
  }
}

function createLocalChatThread(threadId: ChatThreadId, now: number): LocalChatThread {
  return {
    id: threadId,
    title: "New chat",
    source: "local",
    workflowType: "inspectionAnalysis",
    draft: "",
    attachments: [],
    inspectionFiles: {},
    messages: [],
    messagesState: "idle",
    sendState: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function createExampleChatThread(now: number): ExampleChatThread {
  return {
    id: "example-inspection-report-review" as ChatThreadId,
    title: "Inspection report review",
    source: "example",
    workflowType: "inspectionAnalysis",
    draft: "",
    attachments: [],
    inspectionFiles: {},
    messages: [],
    messagesState: "idle",
    sendState: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

export function createInitialChatThreadState(examplesEnabled: boolean): ChatThreadState {
  const now = Date.now();
  const initialThread = examplesEnabled
    ? createExampleChatThread(now)
    : createLocalChatThread(createThreadId(), now);
  return { threads: [initialThread], activeThreadId: initialThread.id, sessionsState: examplesEnabled ? "idle" : "loading" };
}

export interface ChatStageStep {
  stage: ChatStage;
  state: "done" | "active" | "failed" | "queued";
}

const inspectionStageOrder: readonly ChatStage[] = [
  "collectingInputs",
  "extracting",
  "retrieving",
  "drafting",
  "validating",
  "awaitingApproval",
  "exporting",
];

const codeRepairStageOrder: readonly ChatStage[] = [
  "collectingInputs",
  "planning",
  "awaitingApproval",
  "sandboxExecuting",
  "repairing",
];

/**
 * Renderable stage progress for one backend session. Terminal rejection and
 * unknown stage positions stay out of the pipeline; the status chip shows them.
 */
export function chatStageSteps(
  workflowType: ChatWorkflowType,
  stage: ChatStage,
  status: ChatSessionStatus,
): readonly ChatStageStep[] {
  const order = workflowType === "codeRepair" ? codeRepairStageOrder : inspectionStageOrder;
  const currentIndex = order.indexOf(stage);
  if (status === "approvalRejected" || currentIndex < 0) {
    return [];
  }
  if (status === "failed") {
    return order.map((step, index) => ({
      stage: step,
      state: index < currentIndex ? ("done" as const) : index === currentIndex ? ("failed" as const) : ("queued" as const),
    }));
  }
  return order.map((step, index) => ({
    stage: step,
    state: index < currentIndex ? ("done" as const) : index === currentIndex ? ("active" as const) : ("queued" as const),
  }));
}

export const chatStageLabels: Record<ChatStage, string> = {
  collectingInputs: "Collecting inputs",
  extracting: "Extraction",
  retrieving: "Retrieval",
  drafting: "Drafting",
  validating: "Validation",
  planning: "Planning",
  awaitingApproval: "Awaiting approval",
  exporting: "Export",
  sandboxExecuting: "Sandbox execution",
  repairing: "Repair",
  approvalRejected: "Approval rejected",
  completed: "Completed",
  failed: "Failed",
};

export const chatSessionStatusLabel: Record<ChatSessionStatus, string> = {
  active: "Active",
  completed: "Completed",
  failed: "Failed",
  approvalRejected: "Approval rejected",
};
