'use client';

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { PageHeader, PageBody, PageIntro, Button, EmptyState } from '@/components/ui';

// ─── Step definitions ──────────────────────────────────────────────────
// Mirrors USER_STEPS / TEAM_STEPS in apps/api/src/interfaces/trpc/views/journey.ts.
// Duplicated (not imported) because that file pulls in server-only (kysely)
// dependencies this Next.js app can't bundle. These are pure UI labels, not
// logic — keep them in sync if the API's step lists ever change.
const USER_STEPS = ['signed_up', 'mcp_connected', 'first_mcp_call', 'first_automation_saved'] as const;
const TEAM_STEPS = ['created', 'first_automation_saved', 'first_run'] as const;

type UserStep = (typeof USER_STEPS)[number];
type TeamStep = (typeof TEAM_STEPS)[number];
type StepKey = UserStep | TeamStep;
type Subject = 'user' | 'team';

const STEP_LABELS: Record<StepKey, string> = {
  signed_up: 'Signed up',
  mcp_connected: 'Connected',
  first_mcp_call: 'First call',
  first_automation_saved: 'First automation',
  created: 'Created',
  first_run: 'First run',
};

// Which `list` row column each step's date lives in.
const USER_FIELD_BY_STEP: Record<UserStep, string> = {
  signed_up: 'created_at',
  mcp_connected: 'mcp_connected_at',
  first_mcp_call: 'first_mcp_call_at',
  first_automation_saved: 'first_automation_saved_at',
};
const TEAM_FIELD_BY_STEP: Record<TeamStep, string> = {
  created: 'created_at',
  first_automation_saved: 'first_automation_saved_at',
  first_run: 'first_run_at',
};

const SUBJECT_LABELS: Record<Subject, string> = {
  user: 'User journey',
  team: 'Team activation',
};

// ─── Formatting ─────────────────────────────────────────────────────────
// Lifted from apps/admin/src/app/(app)/feed/page.tsx:118 — not exported there,
// so reproduced verbatim rather than re-invented.
function formatRelativeTime(date: Date | string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// A drop-off is only meaningful once there's a prior step to compare against,
// and only trustworthy when it can't go negative. `prev === 0` would divide
// by zero; a negative result means a subject reached a later milestone
// without the earlier one — three documented residual holes (hand-minted API
// keys, X-On-Behalf-Of, a failed fire-and-forget write) make this rare but
// possible. Both degrade to "—" rather than a misleading number.
function dropOffLabel(prev: number | undefined, current: number | undefined): string | null {
  if (prev === undefined || current === undefined) return null;
  if (prev === 0) return '—';
  const pct = ((prev - current) / prev) * 100;
  if (pct < 0) return '—';
  return `${Math.round(pct)}% drop-off`;
}

function cohortNote(subject: Subject, launchAt: Date | string | undefined): string {
  const who = subject === 'user' ? 'people who signed up' : 'teams created';
  const since = launchAt
    ? ` on or after ${new Date(launchAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })}`
    : ' after this tracking went live';
  return `Only counts ${who}${since}. Earlier ones aren't shown at all here — not because they're stuck, but because we only have part of their journey on record.`;
}

// ─── Table primitives (mirrors apps/admin/src/app/(app)/llm-usage/page.tsx) ──
function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-[13px]">{children}</table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="border-b border-gray-100 px-4 py-2.5 text-gray-700 last:border-b-0">
      {children}
    </td>
  );
}

// ─── Subject toggle ─────────────────────────────────────────────────────
function SubjectToggle({ subject, onChange }: { subject: Subject; onChange: (s: Subject) => void }) {
  return (
    <div className="mb-6 inline-flex rounded-lg border border-gray-200 p-0.5">
      {(['user', 'team'] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
            subject === s ? 'bg-primary text-white' : 'text-gray-600 hover:bg-gray-50'
          }`}
        >
          {SUBJECT_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

// ─── Funnel strip ───────────────────────────────────────────────────────
// Styled after the Stat component in feed/page.tsx:155, extended with a
// drop-off line and a selected state since each cell here also acts as a
// filter control (see Funnel below).
function FunnelCell({
  label,
  count,
  dropOff,
  active,
  onClick,
}: {
  label: string;
  count: number | undefined;
  dropOff: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 flex-col items-start border-l border-gray-100 px-4 py-3.5 text-left transition-colors first:border-l-0 hover:bg-gray-50 ${
        active ? 'bg-primary-50' : ''
      }`}
    >
      <span className="text-[21px] font-semibold tabular-nums leading-none text-gray-900">
        {count ?? '—'}
      </span>
      <span className="mt-1.5 text-[11px] uppercase tracking-wide text-gray-400">{label}</span>
      <span className="mt-1 h-[15px] text-[11px] text-gray-400">{dropOff}</span>
    </button>
  );
}

// Renders one subject's funnel row. Generic over the branch's own step-key
// literal type (`S`) so `steps` and `counts` stay correlated — the caller
// narrows on `data.subject` first (a real discriminant), so `S` is inferred
// from that single branch rather than the wider `StepKey` union, and no cast
// is needed to index `counts` by `step`.
function FunnelSteps<S extends StepKey>({
  steps,
  counts,
  stuckAt,
  onSelectStep,
}: {
  steps: readonly S[];
  counts: Record<S, number> | undefined;
  stuckAt: StepKey | null;
  onSelectStep: (step: StepKey) => void;
}) {
  return (
    <div className="mb-2 flex overflow-hidden rounded-xl border border-gray-100">
      {steps.map((step, i) => {
        const count = counts?.[step];
        const prevCount = i === 0 ? undefined : counts?.[steps[i - 1]];
        return (
          <FunnelCell
            key={step}
            label={STEP_LABELS[step]}
            count={count}
            dropOff={i === 0 ? null : dropOffLabel(prevCount, count)}
            active={stuckAt === step}
            onClick={() => onSelectStep(step)}
          />
        );
      })}
    </div>
  );
}

function Funnel({
  subject,
  stuckAt,
  onSelectStep,
}: {
  subject: Subject;
  stuckAt: StepKey | null;
  onSelectStep: (step: StepKey) => void;
}) {
  const { data, isLoading, isError } = trpc.views.journey.funnel.useQuery({ subject });

  if (isError) {
    return <EmptyState title="Couldn't load the funnel" caption="Something went wrong fetching this data. Try refreshing the page." />;
  }

  if (isLoading || !data) {
    const steps = subject === 'user' ? USER_STEPS : TEAM_STEPS;
    return (
      <FunnelSteps
        steps={steps}
        counts={undefined}
        stuckAt={stuckAt}
        onSelectStep={onSelectStep}
      />
    );
  }

  if (data.subject === 'user') {
    return (
      <FunnelSteps
        steps={data.steps}
        counts={data.counts}
        stuckAt={stuckAt}
        onSelectStep={onSelectStep}
      />
    );
  }

  return (
    <FunnelSteps
      steps={data.steps}
      counts={data.counts}
      stuckAt={stuckAt}
      onSelectStep={onSelectStep}
    />
  );
}

// ─── Table ──────────────────────────────────────────────────────────────
type JourneyRow = {
  id: string;
  label: string | null;
  first_mcp_tool?: string | null;
} & Record<string, unknown>;

function JourneyTable({ subject, stuckAt }: { subject: Subject; stuckAt: StepKey | null }) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.views.journey.list.useInfiniteQuery(
      { subject, stuckAt: stuckAt ?? undefined, limit: 50 },
      { getNextPageParam: (last) => last.nextCursor ?? undefined },
    );

  // Unlike `funnel`, `list`'s two branches return the same key names (`rows`,
  // `nextCursor`) with no discriminant field to narrow on, so there's nothing
  // to branch on client-side — and `flatMap` can't unify `UserRow[] | TeamRow[]`
  // on its own (TS2322). A cast is unavoidable here; `JourneyRow`'s
  // `& Record<string, unknown>` catch-all keeps a single `as` sufficient.
  const pages = (data?.pages ?? []) as Array<{ rows: JourneyRow[]; nextCursor: string | null }>;
  const rows = pages.flatMap((page) => page.rows);
  const steps = subject === 'user' ? USER_STEPS : TEAM_STEPS;
  const fieldByStep: Record<string, string> = subject === 'user' ? USER_FIELD_BY_STEP : TEAM_FIELD_BY_STEP;

  if (isError) {
    return <EmptyState title="Couldn't load this table" caption="Something went wrong fetching this data. Try refreshing the page." />;
  }

  if (isLoading) {
    return <p className="text-[13px] text-gray-400">Loading…</p>;
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No one here"
        caption={
          stuckAt
            ? `No one is currently stuck at "${STEP_LABELS[stuckAt]}".`
            : 'No matching activity yet.'
        }
      />
    );
  }

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>{subject === 'user' ? 'User' : 'Team'}</Th>
            {steps.map((step) => (
              <Th key={step}>{STEP_LABELS[step]}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-gray-50">
              <Td>{row.label ?? '—'}</Td>
              {steps.map((step) => {
                const value = row[fieldByStep[step]] as string | Date | null | undefined;
                const tool = subject === 'user' && step === 'first_mcp_call' ? row.first_mcp_tool : null;
                return (
                  <Td key={step}>
                    {value ? formatRelativeTime(value) : '—'}
                    {tool && <span className="ml-1.5 text-gray-400">· {tool}</span>}
                  </Td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Table>
      {hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────
export default function JourneyPage() {
  const [subject, setSubject] = useState<Subject>('user');
  const [stuckAt, setStuckAt] = useState<StepKey | null>(null);

  // Same query key as the one inside `Funnel` below — react-query dedupes it,
  // so this doesn't cost a second request. Needed here (rather than lifting
  // state out of `Funnel`) just to read `launchAt` for the intro copy.
  const { data: funnelData } = trpc.views.journey.funnel.useQuery({ subject });

  // Changing subject MUST clear stuckAt: `list`'s per-subject validation
  // rejects a step that belongs to the other subject.
  const handleSubjectChange = (next: Subject) => {
    setSubject(next);
    setStuckAt(null);
  };

  const handleSelectStep = (step: StepKey) => {
    setStuckAt((current) => (current === step ? null : step));
  };

  return (
    <>
      <PageHeader title="Onboarding" />
      <PageBody width="wide">
        <PageIntro>
          Where people and teams get stuck between signing up and getting an automation
          running. {cohortNote(subject, funnelData?.launchAt)}
        </PageIntro>

        <SubjectToggle subject={subject} onChange={handleSubjectChange} />

        <Funnel subject={subject} stuckAt={stuckAt} onSelectStep={handleSelectStep} />

        <p className="mb-2 mt-2 text-[12px] text-gray-400">
          Each step above counts everyone who&apos;s ever reached it, including people who&apos;ve
          since moved further along. Click a step to see who&apos;s stuck there right now — that
          list will usually be shorter than the step&apos;s count.
        </p>

        {stuckAt && (
          <p className="mb-6 mt-2 text-[12px] text-gray-400">
            Showing {SUBJECT_LABELS[subject].toLowerCase()} stuck at{' '}
            <span className="font-medium text-gray-600">{STEP_LABELS[stuckAt]}</span>.{' '}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => setStuckAt(null)}
            >
              Clear
            </button>
          </p>
        )}
        {!stuckAt && <div className="mb-6" />}

        <JourneyTable subject={subject} stuckAt={stuckAt} />
      </PageBody>
    </>
  );
}
