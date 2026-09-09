import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "agent-sessions";
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — assume crashed after this

type StoredSession = {
  sessionId: string;
  conversationId: string;
  startedAt: number;
};

function getStoredSessions(): Record<string, StoredSession> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function setStoredSessions(sessions: Record<string, StoredSession>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

/**
 * Persists the active agent session to localStorage so it can be resumed
 * if the user navigates away and comes back while the agent is still running.
 *
 * Usage:
 *   const { sessionId, isLoading, start, finish } = useAgentSession(agentType);
 *
 *   // In handleSend:
 *   const { sessionId, conversationId } = start(newSessionId, convId);
 *
 *   // In subscription onData (complete/error):
 *   finish();
 *
 *   // On mount: automatically resumes if a stored session exists for this agent.
 *   // The caller should detect completion by checking if the conversation has
 *   // a newer assistant message than expected.
 */
export function useAgentSession(agentType: string) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const restoredRef = useRef(false);

  // On mount, check for a stored session
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const sessions = getStoredSessions();
    const stored = sessions[agentType];
    if (!stored) return;

    // Expired — clean up
    if (Date.now() - stored.startedAt > MAX_AGE_MS) {
      delete sessions[agentType];
      setStoredSessions(sessions);
      return;
    }

    setSessionId(stored.sessionId);
    setConversationId(stored.conversationId);
    setIsLoading(true);
  }, [agentType]);

  const start = useCallback(
    (newSessionId: string, convId: string) => {
      setSessionId(newSessionId);
      setConversationId(convId);
      setIsLoading(true);

      const sessions = getStoredSessions();
      sessions[agentType] = {
        sessionId: newSessionId,
        conversationId: convId,
        startedAt: Date.now(),
      };
      setStoredSessions(sessions);

      return { sessionId: newSessionId, conversationId: convId };
    },
    [agentType],
  );

  const finish = useCallback(() => {
    setIsLoading(false);
    setSessionId(null);

    const sessions = getStoredSessions();
    delete sessions[agentType];
    setStoredSessions(sessions);
  }, [agentType]);

  const reset = useCallback(() => {
    setSessionId(null);
    setConversationId(null);
    setIsLoading(false);

    const sessions = getStoredSessions();
    delete sessions[agentType];
    setStoredSessions(sessions);
  }, [agentType]);

  return { sessionId, conversationId, setConversationId, isLoading, start, finish, reset };
}
