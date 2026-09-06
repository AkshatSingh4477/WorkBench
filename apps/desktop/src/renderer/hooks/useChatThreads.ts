import { useCallback, useEffect, useReducer, useRef } from "react";
import type { SelectedChatAttachment, SelectedUploadFile, UploadKind } from "../../shared/contracts";

import { LocalApiError, localApi } from "../api/localApi";
import {
  chatSessionTitleFromDraft,
  chatThreadReducer,
  createInitialChatThreadState,
  createThreadId,
  findDeliveredMessage,
  type ChatThread,
  type ChatThreadId,
  type ChatThreadState,
} from "../lib/chatThreads";
export type { ChatThread, ChatThreadId } from "../lib/chatThreads";

export interface ChatThreadsOptions {
  apiBaseUrl: string;
  /** True only for a verified local FastAPI employee session. */
  connected: boolean;
  examplesEnabled: boolean;
}

export interface ChatThreads {
  activeThread: ChatThread;
  createChat: () => void;
  refreshSessions: () => void;
  replaceAttachments: (threadId: ChatThreadId, attachments: readonly SelectedChatAttachment[]) => void;
  retryThreadMessages: (threadId: ChatThreadId) => void;
  selectChat: (threadId: ChatThreadId) => void;
  sendMessage: (threadId: ChatThreadId) => void;
  sessionsState: ChatThreadState["sessionsState"];
  setInspectionFile: (threadId: ChatThreadId, kind: UploadKind, file?: SelectedUploadFile) => void;
  threads: readonly ChatThread[];
  updateDraft: (threadId: ChatThreadId, draft: string) => void;
}

function sendFailureMessage(error: unknown): string {
  if (error instanceof LocalApiError) {
    if (error.kind === "unauthorized") return "Your local employee session could not be verified. Sign in again.";
    if (error.kind === "timeout") return "The local service timed out. The message was not sent.";
    if (error.kind === "network") return "FastAPI is unavailable. The message was not sent.";
    if (error.kind === "http" && error.status === 409) return "This chat session is closed and no longer accepts messages.";
    return error.message;
  }
  return "The message could not be sent.";
}

export function useChatThreads({ apiBaseUrl, connected, examplesEnabled }: ChatThreadsOptions): ChatThreads {
  const [state, dispatch] = useReducer(chatThreadReducer, examplesEnabled, createInitialChatThreadState);
  const stateRef = useRef<ChatThreadState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const sessionsSequenceRef = useRef(0);
  const messageSequencesRef = useRef(new Map<ChatThreadId, number>());
  const sendSequencesRef = useRef(new Map<ChatThreadId, number>());

  const loadSessions = useCallback(() => {
    const requestSequence = ++sessionsSequenceRef.current;
    dispatch({ type: "sessionsLoading" });
    void localApi.listChatSessions(apiBaseUrl).then(
      (response) => {
        if (sessionsSequenceRef.current !== requestSequence) return;
        dispatch({ type: "sessionsLoaded", freshThreadId: createThreadId(), now: Date.now(), sessions: response.sessions });
      },
      () => {
        if (sessionsSequenceRef.current !== requestSequence) return;
        dispatch({ type: "sessionsFailed" });
      },
    );
  }, [apiBaseUrl]);

  useEffect(() => {
    if (connected) {
      loadSessions();
    }
  }, [connected, loadSessions]);

  const loadThreadMessages = useCallback(
    (threadId: ChatThreadId) => {
      const thread = stateRef.current.threads.find((candidate) => candidate.id === threadId);
      if (!thread || thread.sessionId === undefined || thread.messagesState === "loading") return;
      const requestSequence = (messageSequencesRef.current.get(threadId) ?? 0) + 1;
      messageSequencesRef.current.set(threadId, requestSequence);
      dispatch({ type: "messagesLoading", threadId });
      void localApi.listChatMessages(thread.sessionId, apiBaseUrl).then(
        (response) => {
          if (messageSequencesRef.current.get(threadId) === requestSequence) {
            dispatch({ type: "messagesLoaded", threadId, messages: response.messages });
          }
        },
        () => {
          if (messageSequencesRef.current.get(threadId) === requestSequence) {
            dispatch({ type: "messagesFailed", threadId });
          }
        },
      );
    },
    [apiBaseUrl],
  );

  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId) ?? state.threads[0]!;

  // Backend-backed threads fetch their persisted messages when they first become active.
  useEffect(() => {
    if (connected && activeThread.sessionId !== undefined && activeThread.messagesState === "idle") {
      loadThreadMessages(activeThread.id);
    }
  }, [activeThread, connected, loadThreadMessages]);

  const selectChat = useCallback(
    (threadId: ChatThreadId) => {
      dispatch({ type: "select", threadId });
      loadThreadMessages(threadId);
    },
    [loadThreadMessages],
  );

  const retryThreadMessages = useCallback(
    (threadId: ChatThreadId) => {
      loadThreadMessages(threadId);
    },
    [loadThreadMessages],
  );

  const createChat = useCallback(() => {
    const threadId = createThreadId();
    const now = Date.now();
    dispatch({ type: "create", threadId, now });
  }, []);

  const updateDraft = useCallback((threadId: ChatThreadId, draft: string) => {
    const now = Date.now();
    dispatch({ type: "updateDraft", threadId, draft, now });
  }, []);

  const replaceAttachments = useCallback((threadId: ChatThreadId, attachments: readonly SelectedChatAttachment[]) => {
    const now = Date.now();
    dispatch({ type: "replaceAttachments", threadId, attachments, now });
  }, []);

  const setInspectionFile = useCallback((threadId: ChatThreadId, kind: UploadKind, file?: SelectedUploadFile) => {
    const now = Date.now();
    dispatch({ type: "setInspectionFile", threadId, kind, file, now });
  }, []);

  const sendMessage = useCallback(
    (threadId: ChatThreadId) => {
      const thread = stateRef.current.threads.find((candidate) => candidate.id === threadId);
      if (!thread || thread.source === "example" || thread.sendState === "sending") return;
      const content = thread.draft.trim();
      if (content.length === 0) return;
      if (thread.status !== undefined && thread.status !== "active") return;

      const requestSequence = (sendSequencesRef.current.get(threadId) ?? 0) + 1;
      sendSequencesRef.current.set(threadId, requestSequence);
      const submittedDraft = thread.draft;
      // One idempotency key per unresolved append: retries of the same send
      // reuse it, so FastAPI can never store the message twice.
      const clientMessageId = thread.pendingClientMessageId ?? globalThis.crypto.randomUUID();
      dispatch({ type: "sendStarted", threadId, clientMessageId });
      void (async () => {
        let sessionId = thread.sessionId;
        try {
          if (sessionId === undefined) {
            const created = await localApi.createChatSession(
              { workflowType: thread.workflowType, title: chatSessionTitleFromDraft(content) },
              apiBaseUrl,
            );
            if (sendSequencesRef.current.get(threadId) !== requestSequence) return;
            dispatch({ type: "sessionBound", threadId, session: created });
            sessionId = created.sessionId;
          }
          const message = await localApi.appendChatMessage(
            sessionId,
            { content, clientMessageId },
            apiBaseUrl,
          );
          if (sendSequencesRef.current.get(threadId) !== requestSequence) return;
          dispatch({ type: "messageAppended", threadId, message, now: Date.now() });
          dispatch({ type: "draftClearedIfUnchanged", threadId, draft: submittedDraft, now: Date.now() });
          try {
            const refreshed = await localApi.getChatSession(sessionId, apiBaseUrl);
            if (sendSequencesRef.current.get(threadId) !== requestSequence) return;
            dispatch({ type: "sessionSynced", threadId, session: refreshed });
          } catch {
            // The message is stored; a failed stage refresh is visible state lag, not a lost message.
          }
        } catch (error) {
          if (sendSequencesRef.current.get(threadId) !== requestSequence) return;
          // An append can commit on FastAPI and still fail here. The key
          // decides, not content: the stored list either contains this
          // exact request (delivered) or a successful read proves it was
          // never stored (definitively failed, key released). A failed
          // reconciliation read keeps both draft and key for a safe retry.
          if (sessionId !== undefined) {
            try {
              const stored = await localApi.listChatMessages(sessionId, apiBaseUrl);
              if (sendSequencesRef.current.get(threadId) !== requestSequence) return;
              const delivered = findDeliveredMessage(stored.messages, clientMessageId);
              if (delivered !== undefined) {
                dispatch({ type: "messagesLoaded", threadId, messages: stored.messages });
                dispatch({ type: "draftClearedIfUnchanged", threadId, draft: submittedDraft, now: Date.now() });
                dispatch({ type: "sendResolved", threadId, now: Date.now() });
                return;
              }
              dispatch({ type: "sendFailed", threadId, message: sendFailureMessage(error), definitive: true });
              return;
            } catch {
              // Reconciliation failed too; the append error stays visible.
            }
          }
          dispatch({ type: "sendFailed", threadId, message: sendFailureMessage(error), definitive: sessionId === undefined });
        }
      })();
    },
    [apiBaseUrl],
  );

  return {
    activeThread,
    createChat,
    refreshSessions: loadSessions,
    replaceAttachments,
    retryThreadMessages,
    selectChat,
    sendMessage,
    sessionsState: state.sessionsState,
    setInspectionFile,
    threads: state.threads,
    updateDraft,
  };
}
