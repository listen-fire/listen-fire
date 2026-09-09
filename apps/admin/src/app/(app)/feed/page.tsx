'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { enablePush } from '@/lib/push';
import { PageHeader, PageBody, PageIntro, CardList, Button, EmptyState } from '@/components/ui';
import { EmojiText } from '@/components/emoji-text';
import { FeedTime } from '@/components/feed-time';
import { Dropdown, type DropdownOption } from '@/components/dropdown';
import { OpsEventType, OpsRunStatus, OpsSeverity } from '#trpc';
import { parseErrorTitle, summarizeErrorTitle } from './detail-payloads';

const EVENT_TYPES: OpsEventType[] = [
  OpsEventType.PORTFOLIO,
  OpsEventType.DEALFLOW,
  OpsEventType.DIRECTORY,
  OpsEventType.LIVE_FEED,
  OpsEventType.ONBOARDING,
  OpsEventType.SCHEDULED_COMMS,
  OpsEventType.SUPPORT,
  OpsEventType.SOCIAL,
  OpsEventType.METRICS,
  OpsEventType.OVI,
];

// Human-facing labels for event types whose internal enum name differs from what
// we want operators to read. OVI is the internal name for inbound WhatsApp.
const TYPE_LABELS: Partial<Record<OpsEventType, string>> = {
  [OpsEventType.OVI]: 'WhatsApp',
};

function typeLabel(type: OpsEventType): string {
  return TYPE_LABELS[type] ?? type;
}

const TYPE_OPTIONS: DropdownOption[] = [
  { value: '', label: 'All types' },
  ...EVENT_TYPES.map((t) => ({ value: t, label: typeLabel(t) })),
];

// The severity dropdown mixes real severities with one preset: "Needs
// attention" is the triage view — everything still unresolved that went wrong,
// which is a question the server answers, not a severity. Its value is opaque;
// the page translates it into the listFeed input below.
const NEEDS_ATTENTION = 'needsAttention';
const SEVERITY_OPTIONS: DropdownOption[] = [
  { value: '', label: 'All' },
  { value: NEEDS_ATTENTION, label: 'Needs attention' },
  { value: OpsSeverity.notable, label: 'Notable' },
  { value: OpsSeverity.info, label: 'Info' },
];

// ─── Row semantics ────────────────────────────────────────────────────

type FeedRow = {
  id: string;
  type: OpsEventType;
  severity: OpsSeverity;
  status: OpsRunStatus | null;
  title: string;
  team_name: string | null;
  request_id: string | null;
  created_at: Date | string;
  updated_at: Date | string | null;
  resolved_at: Date | string | null;
};

type Health = 'crit' | 'warn' | 'run' | 'wait' | 'ok';

// Collapse status + severity into one at-a-glance health signal. Worst wins;
// a plain completion is "ok" and gets no rail, so healthy runs recede.
function healthTone(row: FeedRow): Health {
  if (row.status === OpsRunStatus.failed || row.severity === OpsSeverity.critical) return 'crit';
  if (row.severity === OpsSeverity.warn) return 'warn';
  // Waiting on a person is its own state, not a slow run and not a problem —
  // nothing is wrong and nothing is happening until someone answers.
  if (row.status === OpsRunStatus.parked) return 'wait';
  if (row.status === OpsRunStatus.running) return 'run';
  return 'ok';
}

function stateLabel(row: FeedRow, tone: Health): string | null {
  if (tone === 'crit') return row.status === OpsRunStatus.failed ? 'Failed' : 'Critical';
  if (tone === 'warn') return 'Review';
  if (tone === 'run') return 'Running';
  if (tone === 'wait') return 'Waiting for a person';
  return null;
}

const RAIL: Record<Health, string> = {
  crit: 'bg-red-500',
  warn: 'bg-amber-500',
  run: 'bg-blue-500',
  wait: 'bg-violet-400',
  ok: 'bg-transparent',
};

const ROW_BG: Record<Health, string> = {
  crit: 'bg-red-50/40 hover:bg-red-50',
  warn: 'bg-amber-50/40 hover:bg-amber-50',
  run: 'hover:bg-gray-50',
  wait: 'hover:bg-gray-50',
  ok: 'hover:bg-gray-50',
};

const STATE_TONE: Record<Health, string> = {
  crit: 'text-red-600',
  warn: 'text-amber-600',
  run: 'text-blue-600',
  wait: 'text-violet-600',
  ok: '',
};

// A resolved row keeps its state — a failed run still reads "Failed" — but
// stops competing for the eye: the rail and the tint step back to neutral so
// only live rows carry colour.
const RESOLVED_RAIL = 'bg-gray-200';
const RESOLVED_ROW_BG = 'hover:bg-gray-50';
const RESOLVED_STATE_TONE = 'text-gray-400';

// Keep raw nulls out of the feed. Root cause for some of these is the Slack
// dual-write funnel (a follow-up), but the render layer must never leak "null".
function describe(row: FeedRow): { title: string; team: string } {
  const cleaned = row.title.replace(/\s*from:?\s*null\b.*/i, '').trim() || row.title;
  // A thrown-error title is mostly JSON, which the row's single line would spend
  // itself on before reaching anything a human reads.
  const error = parseErrorTitle(cleaned);
  return {
    title: error ? summarizeErrorTitle(error) : cleaned,
    team: row.team_name ?? 'Unassigned',
  };
}

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

const GROUP_ORDER = ['Just now', 'Earlier today', 'Yesterday', 'Older'] as const;

function groupLabel(date: Date | string): (typeof GROUP_ORDER)[number] {
  const t = new Date(date).getTime();
  if (Date.now() - t < 15 * 60_000) return 'Just now';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 24 * 60 * 60 * 1000;
  if (t >= startToday) return 'Earlier today';
  if (t >= startYesterday) return 'Yesterday';
  return 'Older';
}

function groupRows(rows: FeedRow[]): { label: string; rows: FeedRow[] }[] {
  const buckets = new Map<string, FeedRow[]>();
  for (const row of rows) {
    const label = groupLabel(row.updated_at ?? row.created_at);
    const list = buckets.get(label) ?? [];
    list.push(row);
    buckets.set(label, list);
  }
  return GROUP_ORDER.filter((l) => buckets.has(l)).map((l) => ({ label: l, rows: buckets.get(l)! }));
}

// ─── Summary strip ────────────────────────────────────────────────────

function Stat({
  n,
  label,
  tone,
  onClick,
}: {
  n: number | undefined;
  label: string;
  tone?: 'run' | 'wait' | 'alert';
  onClick?: () => void;
}) {
  const numTone =
    tone === 'run'
      ? 'text-blue-600'
      : tone === 'wait'
        ? 'text-violet-600'
        : tone === 'alert'
          ? 'text-red-600'
          : 'text-gray-900';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex flex-col items-start border-l border-gray-100 px-4 py-3.5 text-left transition-colors first:border-l-0 enabled:cursor-pointer enabled:hover:bg-gray-50"
    >
      <span className={`text-[21px] font-semibold tabular-nums leading-none ${numTone}`}>
        {n ?? '—'}
      </span>
      <span className="mt-1.5 text-[11px] uppercase tracking-wide text-gray-400">{label}</span>
    </button>
  );
}

// ─── Notifications ────────────────────────────────────────────────────

function EnableNotificationsButton() {
  const { data: vapidPublicKey } = trpc.views.ops.vapidPublicKey.useQuery();
  const { mutateAsync: register } = trpc.views.ops.registerDevice.useMutation();
  const [status, setStatus] = useState<'granted' | 'denied' | 'unsupported' | null>(null);
  const [loading, setLoading] = useState(false);

  const handleEnable = async () => {
    if (!vapidPublicKey) return;
    setLoading(true);
    try {
      const result = await enablePush({ vapidPublicKey, register });
      setStatus(result);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {status === 'granted' && (
        <span className="text-[12px] text-emerald-600">Notifications enabled</span>
      )}
      {status === 'denied' && <span className="text-[12px] text-red-600">Permission denied</span>}
      {status === 'unsupported' && (
        <span className="text-[12px] text-gray-400">Not supported on this device</span>
      )}
      {status !== 'granted' && (
        <Button
          variant="secondary"
          size="sm"
          onClick={handleEnable}
          disabled={loading || !vapidPublicKey}
        >
          {loading ? 'Enabling…' : 'Enable notifications on this device'}
        </Button>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────

export default function FeedPage() {
  const [typeFilter, setTypeFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');

  const { data: summary } = trpc.views.ops.summary.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.views.ops.listFeed.useInfiniteQuery(
      {
        type: typeFilter ? (typeFilter as OpsEventType) : undefined,
        needsAttention: severityFilter === NEEDS_ATTENTION ? true : undefined,
        severity:
          severityFilter && severityFilter !== NEEDS_ATTENTION
            ? (severityFilter as OpsSeverity)
            : undefined,
        limit: 50,
      },
      { getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined },
    );

  const rows = (data?.pages.flatMap((page) => page.items) ?? []) as FeedRow[];
  const groups = groupRows(rows);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <>
      <PageHeader title="Operations Feed" actions={<EnableNotificationsButton />} />
      <PageBody>
        <PageIntro>
          Every team&apos;s activity in one stream. Anything needing attention carries a coloured
          edge; healthy runs stay quiet.
        </PageIntro>

        <div className="mb-4 grid grid-cols-2 overflow-hidden rounded-xl border border-gray-100 sm:grid-cols-4">
          <Stat n={summary?.running} label="Running" tone="run" />
          <Stat n={summary?.parked} label="Waiting" tone="wait" />
          <Stat
            n={summary?.needsAttention}
            label="Need attention"
            tone="alert"
            onClick={() => setSeverityFilter(NEEDS_ATTENTION)}
          />
          <Stat n={summary?.teamsActive} label="Teams active" />
          <Stat n={summary?.runsToday} label="Runs today" />
        </div>

        <div className="mb-6 flex flex-wrap gap-2.5">
          <Dropdown label="Type" value={typeFilter} options={TYPE_OPTIONS} onChange={setTypeFilter} />
          <Dropdown
            label="Severity"
            value={severityFilter}
            options={SEVERITY_OPTIONS}
            onChange={setSeverityFilter}
          />
        </div>

        {isLoading ? (
          <p className="text-[13px] text-gray-400">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState title="No events" caption="Events will appear here as they occur." />
        ) : (
          <>
            {groups.map((group) => (
              <section key={group.label} className="mb-7">
                <h2 className="mb-2.5 ml-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {group.label}
                </h2>
                <CardList>
                  {group.rows.map((row) => {
                    const tone = healthTone(row);
                    const state = stateLabel(row, tone);
                    const resolved = row.resolved_at != null;
                    const { title, team } = describe(row);
                    return (
                      <Link
                        key={row.id}
                        href={`/feed/${row.id}`}
                        className={`grid grid-cols-[3px_1fr_auto] gap-x-4 px-4 py-3.5 transition-colors ${
                          resolved ? RESOLVED_ROW_BG : ROW_BG[tone]
                        }`}
                      >
                        <span
                          className={`[grid-row:1/-1] rounded-full ${
                            resolved ? RESOLVED_RAIL : RAIL[tone]
                          }`}
                          aria-hidden
                        />
                        <div className={`min-w-0 ${resolved ? 'opacity-55' : ''}`}>
                          <div className="truncate text-[13.5px] font-medium text-gray-800">
                            <EmojiText>{title}</EmojiText>
                          </div>
                          <div className="mt-1 truncate text-[12.5px] text-gray-400">
                            <span className="font-medium uppercase tracking-wide text-gray-500">
                              {typeLabel(row.type)}
                            </span>
                            {' · '}
                            {team}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                          <FeedTime
                            label={formatRelativeTime(row.updated_at ?? row.created_at)}
                            requestId={row.request_id}
                          />
                          {(state || resolved) && (
                            <span className="flex items-center gap-1.5 text-[11.5px] font-semibold">
                              {resolved && <span className="text-emerald-600">Resolved</span>}
                              {resolved && state && <span className="text-gray-300">·</span>}
                              {state && (
                                <span
                                  className={`flex items-center gap-1.5 ${
                                    resolved ? RESOLVED_STATE_TONE : STATE_TONE[tone]
                                  }`}
                                >
                                  {!resolved && tone === 'run' && (
                                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                                  )}
                                  {state}
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      </Link>
                    );
                  })}
                </CardList>
              </section>
            ))}
            <div ref={sentinelRef} aria-hidden className="h-px" />
            {isFetchingNextPage && (
              <p className="mt-4 text-center text-[12px] text-gray-400">Loading more…</p>
            )}
            {!hasNextPage && <p className="mt-4 text-center text-[12px] text-gray-300">End of feed</p>}
          </>
        )}
      </PageBody>
    </>
  );
}
