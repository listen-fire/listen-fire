"use client";

import { useRef, useEffect } from "react";

/**
 * Sets document.title and keeps it stable across React re-renders.
 * Next.js server-renders <title> from root metadata; this overrides
 * it client-side using a MutationObserver to prevent hydration from
 * resetting the title.
 */
export function usePageTitle(title: string) {
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    document.title = titleRef.current;

    const el = document.querySelector("title");
    if (!el) return;

    const observer = new MutationObserver(() => {
      if (document.title !== titleRef.current) {
        document.title = titleRef.current;
      }
    });

    observer.observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [title]);
}
