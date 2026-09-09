"use client";

/**
 * A copyable movement-import snippet — `import { name } from namespace` —
 * rendered as a small monospace chip. Shared by the Credentials, Adapters,
 * and Plugins pages so every catalogue surface presents the language's
 * import nomenclature identically.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function ImportSnippet({
  name,
  from,
}: {
  /** The identifier the movement imports (e.g. `dev_loop_attio`). */
  name: string;
  /** The built-in namespace it comes from. */
  from: "adapters" | "credentials" | "plugins";
}) {
  const [copied, setCopied] = useState(false);
  const snippet = `import { ${name} } from ${from}`;

  return (
    <button
      type="button"
      title={`Copy "${snippet}"`}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(snippet);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (permissions / non-secure context) — the
          // snippet is still visible to copy by hand.
        }
      }}
      className="group inline-flex max-w-full items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-500 transition-colors hover:border-gray-300 hover:bg-gray-100"
    >
      <span className="truncate">
        <span className="text-gray-400">import {"{ "}</span>
        <span className="font-medium text-gray-700">{name}</span>
        <span className="text-gray-400">
          {" }"} from {from}
        </span>
      </span>
      {copied ? (
        <Check size={11} className="shrink-0 text-emerald-500" />
      ) : (
        <Copy
          size={11}
          className="shrink-0 text-gray-300 transition-colors group-hover:text-gray-500"
        />
      )}
    </button>
  );
}
