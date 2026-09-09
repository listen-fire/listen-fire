/**
 * A stable id for THIS browser tab, generated once per load. It's sent on
 * mutations (the `x-listen-fire-origin` header) and stamped onto the resulting
 * resource-change events, so a tab can ignore the changes IT made — it
 * already reflects its own edits. A tab's *other* tabs, teammates, the
 * API, and the agent all carry a different (or no) origin, so those still
 * refresh.
 */
export const TAB_ORIGIN_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
