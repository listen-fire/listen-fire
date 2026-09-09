"use client";

/**
 * Page context registry — pages publish a typed snapshot of what the
 * user is looking at ({ page, entities, extras }), and the assistant
 * panel attaches it to every agent turn as a structured context block.
 *
 * Context INFORMS the agent ("the user is currently viewing …"); it
 * never authorises anything — scopes on the API side stay the only
 * capability boundary.
 *
 * Usage, from any page or component inside the app shell:
 *
 *   usePublishPageContext(
 *     useMemo(() => ({
 *       page: "Movement editor",
 *       entities: [{ kind: "movement", id, name }],
 *       extras: { "current draft script": source },
 *     }), [id, name, source]),
 *   );
 *
 * The hook publishes on mount/change and clears on unmount, so the
 * registry always reflects the page actually on screen. Pages that
 * publish nothing still get a route-level fallback (the panel sends
 * the pathname regardless).
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export type PageEntity = {
  /** What kind of thing this is, e.g. "movement", "automation", "credential". */
  kind: string;
  id?: string;
  name?: string;
};

export type PageContext = {
  /** Human-readable page name, e.g. "Movement editor". */
  page: string;
  /** Named things on screen. */
  entities?: PageEntity[];
  /** Page-specific state, e.g. the editor's current draft script. */
  extras?: Record<string, string>;
};

type PageContextRegistry = {
  published: PageContext | null;
  publish: Dispatch<SetStateAction<PageContext | null>>;
};

const PageContextCtx = createContext<PageContextRegistry | null>(null);

export function PageContextProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [published, setPublished] = useState<PageContext | null>(null);
  const value = useMemo(
    () => ({ published, publish: setPublished }),
    [published],
  );
  return (
    <PageContextCtx.Provider value={value}>{children}</PageContextCtx.Provider>
  );
}

/**
 * Publish this page's context while the calling component is mounted.
 * Passing null publishes nothing (a no-op, so a conditional publisher
 * never clobbers a sibling's context). On unmount or change, only the
 * value THIS hook published is cleared — two publishers trading places
 * across a route transition resolve to whichever is still mounted,
 * regardless of effect ordering.
 */
export function usePublishPageContext(context: PageContext | null) {
  const registry = useContext(PageContextCtx);
  const publish = registry?.publish;
  // Value-compare via serialization so changing object identity alone
  // doesn't republish (pages rebuild the object every render).
  const serialized = context === null ? null : JSON.stringify(context);

  useEffect(() => {
    if (!publish || serialized === null) return;
    const mine = JSON.parse(serialized) as PageContext;
    publish(mine);
    return () => publish((prev) => (prev === mine ? null : prev));
  }, [publish, serialized]);
}

/** The currently-published page context, or null. Used by the assistant panel. */
export function usePublishedPageContext(): PageContext | null {
  return useContext(PageContextCtx)?.published ?? null;
}
