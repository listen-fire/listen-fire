"use client";

/**
 * A subtle "automations running right now" badge for the sidebar foot.
 *
 * There's no persisted in-flight state to query — a run becomes a
 * `trigger_run` row only once it finishes — so the count is built purely
 * from the live `triggers.onRunActivity` ticks: `started` adds a run,
 * `finished` removes it. To stay honest when an end tick is missed (a
 * crash, or a run that began before this tab connected), entries expire
 * after a grace window. Renders nothing when nothing is running.
 */

import { useEffect, useRef, useState } from "react";

import { unitIsMounted } from "@/lib/capabilities";
import { useCapabilities } from "@/lib/capabilities-provider";
import { trpc } from "@/lib/trpc";

const STALE_MS = 120_000;
const SWEEP_MS = 15_000;

export function RunningIndicator({ collapsed }: { collapsed?: boolean }) {
  // runId → started-at (ms). A ref holds the source of truth; `count`
  // mirrors its size to drive renders.
  const runsRef = useRef<Map<string, number>>(new Map());
  const [count, setCount] = useState(0);

  const sync = () => setCount(runsRef.current.size);

  const capabilities = useCapabilities();

  trpc.views.triggers.onRunActivity.useSubscription(undefined, {
    enabled: unitIsMounted("automations", capabilities),
    onData: (evt) => {
      if (evt.phase === "started") runsRef.current.set(evt.runId, Date.now());
      else runsRef.current.delete(evt.runId);
      sync();
    },
  });

  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - STALE_MS;
      let changed = false;
      for (const [id, ts] of runsRef.current) {
        if (ts < cutoff) {
          runsRef.current.delete(id);
          changed = true;
        }
      }
      if (changed) sync();
    }, SWEEP_MS);
    return () => clearInterval(t);
  }, []);

  if (count === 0) return null;

  const dot = (
    <span className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
    </span>
  );

  if (collapsed) {
    return (
      <div
        className="flex items-center justify-center py-1"
        title={`${count} automation${count === 1 ? "" : "s"} running`}
      >
        {dot}
      </div>
    );
  }

  return (
    <div className="mb-1 flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] text-gray-500">
      {dot}
      <span>
        {count} automation{count === 1 ? "" : "s"} running
      </span>
    </div>
  );
}
