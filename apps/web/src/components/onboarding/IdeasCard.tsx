"use client";

/**
 * Card 3 — recognition, not generation. The user picks the tools they use and
 * Listen-Fire drafts concrete automations for that mix (one server-side model call
 * per mix — see the `workflowIdeas` view router). Each idea is a rough,
 * effect-level ask: open it straight in Claude, or copy it.
 *
 * The picks ARE the button: ideas draft as soon as two tools are down and
 * redraft on every change to the mix after that.
 */

import { useMemo, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import { trpc } from "@/lib/trpc";

import { PulsingEllipsis } from "./PulsingEllipsis";
import { ServicePickerBox } from "./ServicePickerBox";
import { PICKER_SERVICE_LABELS, PICKER_SERVICES } from "./services";

const MIN_PICKS = 2;

interface Idea {
  tag: string;
  text: string;
}

export function IdeasCard({ onIdeas }: { onIdeas: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The mix we last drafted for — so re-renders and a deselect/reselect that
  // lands back on the same mix don't burn a redundant model call.
  const requestedMix = useRef<string | null>(null);
  const generate = trpc.views.workflowIdeas.generate.useMutation({
    onSuccess: onIdeas,
    // Forget a failed mix so re-picking the same tools retries it.
    onError: () => {
      requestedMix.current = null;
    },
  });
  const ideas = generate.data?.ideas;

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);

    // Two picks are enough to draft; every change to the mix after that
    // redrafts. (React Query surfaces only the latest mutate, so a slow
    // earlier draft can't overwrite a newer one.)
    if (next.size >= MIN_PICKS) {
      // Adapter slugs, so the server can ground each idea in a real manifest.
      const services = PICKER_SERVICES.filter((s) => next.has(s.key)).map((s) =>
        s.key.toLowerCase(),
      );
      const mix = services.join("+");
      if (mix === requestedMix.current) return;
      requestedMix.current = mix;
      generate.mutate({ services });
    }
  };

  return (
    <div className="flex flex-col items-center gap-8" data-testid="ideas-card">
      <h1 className="text-[26px] font-semibold tracking-tight text-gray-900">
        Pick your tools to start
      </h1>

      <div className="flex flex-wrap justify-center gap-3.5">
        {PICKER_SERVICES.map((service) => (
          <ServicePickerBox
            key={service.key}
            service={service}
            selected={selected.has(service.key)}
            onToggle={() => toggle(service.key)}
          />
        ))}
      </div>

      {generate.isLoading && <PulsingEllipsis size="sm" />}

      {generate.isError && !generate.isLoading && (
        <p className="text-[12px] text-gray-400">Nothing came back. Change a tool to retry.</p>
      )}

      {ideas && !generate.isLoading && (
        <div className="grid w-full gap-3 sm:grid-cols-2">
          {ideas.map((idea, i) => (
            <PromptTile key={`${idea.text}-${i}`} tag={idea.tag} text={idea.text} />
          ))}
        </div>
      )}
    </div>
  );
}

function HighlightedPrompt({ text }: { text: string }) {
  const pattern = useMemo(
    () => new RegExp(`(${PICKER_SERVICE_LABELS.join("|")})`, "g"),
    [],
  );
  return (
    <>
      {text.split(pattern).map((part, i) =>
        PICKER_SERVICE_LABELS.includes(part) ? (
          <span
            key={i}
            className="rounded-md bg-primary/10 px-1 py-px font-medium text-primary"
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** The whole tile is one link: open the idea in Claude, prefilled.
 *  (https://claude.ai/new?q= prefills the web composer and is the hand-off
 *  link that opens the mobile app when it's installed.) */
function PromptTile({ tag, text }: Idea) {
  return (
    <a
      href={`https://claude.ai/new?q=${encodeURIComponent(text)}`}
      target="_blank"
      rel="noreferrer"
      className="group flex flex-col gap-2.5 rounded-xl border border-gray-200 px-4 py-3.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.03]"
      data-testid="prompt-template"
    >
      <span className="flex w-full items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-gray-400">
          {tag}
        </span>
        <span className="flex items-center gap-1 text-[12px] font-medium text-primary/50 transition-colors group-hover:text-primary">
          Open in Claude
          <ExternalLink size={11} />
        </span>
      </span>
      <span className="text-[14px] leading-relaxed text-gray-700">
        <HighlightedPrompt text={text} />
      </span>
    </a>
  );
}
