/**
 * A stable id for THIS browser tab, generated once per load. It's sent on
 * mutations (the `x-listen-fire-origin` header) and stamped onto the resulting
 * resource-change events, so a tab can ignore the changes IT made — it
 * already reflects its own edits.
 */
export const TAB_ORIGIN_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
