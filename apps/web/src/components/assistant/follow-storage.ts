/**
 * Per-tab persistence for follow-along arming, keyed by conversation.
 *
 * Follow state is a borrowed steering wheel scoped to a (tab, conversation)
 * pair — it lives in sessionStorage so it dies with the tab but survives a
 * reload, and never leaks across tabs or users (plans/2026-06-16-follow-along
 * principle 4). "Armed" is the only persisted bit; pause is transient
 * in-memory state the controller holds.
 */

const KEY = "followAlong";

type FollowMap = Record<string, boolean>;

function read(): FollowMap {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as FollowMap) : {};
  } catch {
    return {};
  }
}

function write(map: FollowMap) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // sessionStorage unavailable (SSR / privacy mode) — follow just won't persist.
  }
}

export function readFollowArmed(conversationId: string): boolean {
  return read()[conversationId] ?? false;
}

export function writeFollowArmed(conversationId: string, armed: boolean) {
  const map = read();
  if (armed) map[conversationId] = true;
  else delete map[conversationId];
  write(map);
}
