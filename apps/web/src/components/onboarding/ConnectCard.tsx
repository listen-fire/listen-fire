"use client";

/**
 * Card 1 — add Listen-Fire to Claude. One headline, one action, one quiet caveat.
 *
 * `NEXT_PUBLIC_CLAUDE_DIRECTORY_URL` is a build-time flag: set it only for the
 * one deployment Anthropic actually lists in Claude's connector directory,
 * and this renders the one-click "add from the directory" button. Every other
 * deployment — every self-host — has no listing of its own, so it falls back
 * to the custom-connector steps, pointed at THIS install's own automation MCP
 * URL (read from capabilities, never guessed from the browser's origin — a
 * reverse proxy or a different public hostname would make that guess wrong).
 */

import { useState } from "react";

import { Button, buttonClass } from "@/components/ui";
import { useCapabilities, useCapabilitiesSettled } from "@/lib/capabilities-provider";

const CLAUDE_DIRECTORY_URL = process.env.NEXT_PUBLIC_CLAUDE_DIRECTORY_URL;
const CONNECTORS_URL = "https://claude.ai/settings/connectors";

export function ConnectCard({ onAction }: { onAction: () => void }) {
  return (
    <div className="flex flex-col items-center gap-8" data-testid="connect-card">
      <h1 className="text-[26px] font-semibold tracking-tight text-gray-900">
        Get Claude automating
      </h1>

      {CLAUDE_DIRECTORY_URL ? (
        <StoreAction url={CLAUDE_DIRECTORY_URL} onAction={onAction} />
      ) : (
        <PasteUrlAction onAction={onAction} />
      )}

      <p className="text-[12px] text-gray-400">
        Team plan? Your Claude admin may need to add it.
      </p>
    </div>
  );
}

function StoreAction({ url, onAction }: { url: string; onAction: () => void }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onAction}
      className={buttonClass({ variant: "primary" })}
      data-testid="add-to-claude"
    >
      Add Listen-Fire to Claude
    </a>
  );
}

/** The self-hosted flow: copy this install's own connector URL, then walk
 *  through Claude's custom-connector dialog by hand. */
function PasteUrlAction({ onAction }: { onAction: () => void }) {
  const [copied, setCopied] = useState(false);
  const capabilities = useCapabilities();
  const settled = useCapabilitiesSettled();
  const url = capabilities?.mcp?.automation;

  // A deployment that does not run automations has nothing to connect Claude
  // to — say so rather than rendering a copy button for a URL that doesn't
  // exist.
  if (settled && !url) {
    return (
      <p
        className="max-w-xs text-center text-[13px] text-gray-500"
        data-testid="connect-card-unavailable"
      >
        This deployment doesn&apos;t run automations, so there&apos;s no connector to add.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <Button
        variant="primary"
        disabled={!url}
        onClick={() => {
          if (!url) return;
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            onAction();
          });
        }}
        data-testid="copy-connector-url"
      >
        {copied ? "Copied" : "Copy the link"}
      </Button>
      <ol className="max-w-xs list-decimal space-y-1 pl-4 text-left text-[12px] text-gray-400">
        <li>
          Open Claude, then{" "}
          <a
            href={CONNECTORS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-gray-200 underline-offset-2 hover:text-gray-600"
          >
            Settings → Connectors
          </a>
        </li>
        <li>Choose &quot;Add custom connector&quot;</li>
        <li>Paste the link you just copied</li>
        <li>Claude sends you back here to sign in</li>
      </ol>
    </div>
  );
}
