"use client";

import { FlowCanvas } from "../flow-canvas";
import { ValidityNotice } from "../notices";
import { ReferentsProvider } from "../referents";
import type { StoryView } from "../view";

/**
 * The STANDALONE MOUNT — the whole page a story link opens.
 *
 * Minimal chrome by intent: whose product this is, which automation you are
 * looking at, and whether the thing is actually working. Everything else on
 * the page is the story itself, drawn by the very components the app's
 * workbench panel draws it with.
 *
 * No navigation, no controls, no code: the person holding this link is being
 * shown what an automation does, and every affordance that isn't that is a
 * door they cannot open.
 *
 */
export function StoryPage({ view }: { view: StoryView }) {
  return (
    <ReferentsProvider view={view}>
      <div className="flex h-full min-h-0 flex-col bg-white px-6 py-5">
        <div className="shrink-0">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="truncate text-[15px] font-medium text-gray-900">
              {view.movement.name}
            </h1>
            <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.16em] text-primary-500">
              Listen-Fire
            </span>
          </div>
          <p className="mb-4 mt-0.5 text-[12px] text-gray-400">
            What this automation does
          </p>
          <ValidityNotice validity={view.movement.validity} />
        </div>
        <div className="min-h-0 flex-1">
          <FlowCanvas view={view} />
        </div>
      </div>
    </ReferentsProvider>
  );
}
