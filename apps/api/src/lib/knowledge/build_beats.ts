// Pure projection: a completed movement-authoring tool call → a build beat
// for the demo-mode build stage (plans/2026-06-16-demo-build-stage). Each beat
// names the phase and surfaces the REAL artifact the agent is working on — the
// playbook passage, the schema it found, the options it picked — so the
// assistant panel can narrate the build. Returns null for tools that don't
// produce a watchable beat.

import type { BuildBeat } from '../openai/types';

interface ToolCall {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
}

const truncate = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function beatForToolCall({ name, args, result }: ToolCall): BuildBeat | null {
  switch (name) {
    case 'readAuthoringDoc': {
      const chapter = result?.title ?? args?.chapter ?? 'the';
      const body = typeof result?.body === 'string' ? truncate(result.body) : undefined;
      return {
        phase: 'read',
        label: `Reading the ${chapter} playbook`,
        ...(body ? { artifact: body } : {}),
      };
    }
    case 'readBook': {
      // The unified agent's Library tool. Single read → `{ title, content }`;
      // multi read → `{ chapters: [{ title, content }] }`.
      if (Array.isArray(result?.chapters)) {
        const titles = result.chapters
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((c: any) => c?.title ?? c?.id)
          .filter(Boolean);
        return {
          phase: 'read',
          label: titles.length === 1 ? `Reading the ${titles[0]} playbook` : `Reading ${titles.length} playbook chapters`,
          ...(titles.length ? { artifact: titles.join(' · ') } : {}),
        };
      }
      const chapter = result?.title ?? args?.chapter ?? args?.bookId ?? 'the';
      const body = typeof result?.content === 'string' ? truncate(result.content) : undefined;
      return {
        phase: 'read',
        label: `Reading the ${chapter} playbook`,
        ...(body ? { artifact: body } : {}),
      };
    }
    case 'listCatalog':
      return { phase: 'study', label: 'Looking over your connected tools' };
    case 'describeInstance': {
      const adapter = args?.adapter ?? 'the tool';
      // The WALK's answer: where we're standing and what leaves it. This read
      // `result.writableRoots` — a top-level field `DescribedInstance` has
      // never had (writable roots live under `schema`), so the summary was
      // always empty and the beat never showed an artifact. Silent, because an
      // absent optional artifact looks exactly like a deliberate one.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = result?.node as any;
      const edges: any[] = Array.isArray(node?.edges) ? node.edges : [];
      const summary = edges
        .map((e) => (e?.writable === true ? `${e?.name} (writable)` : e?.name))
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('  ·  ');
      return {
        phase: 'study',
        label: node?.name ? `Studying ${adapter} — ${node.name}` : `Studying ${adapter}`,
        ...(summary ? { artifact: truncate(summary) } : {}),
      };
    }
    case 'completionsAt': {
      const opts = (result?.completions ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c?.label)
        .filter(Boolean)
        .slice(0, 6)
        .join(', ');
      return {
        phase: 'fill',
        label: 'Choosing from the real options',
        ...(opts ? { artifact: opts } : {}),
      };
    }
    default:
      return null;
  }
}
