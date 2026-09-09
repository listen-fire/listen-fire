'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { trpc } from '@/lib/trpc';
import {
  PageHeader,
  PageBody,
  Badge,
  Button,
  ButtonLink,
} from '@/components/ui';
import { EmojiText } from '@/components/emoji-text';
import { RequestIdLink } from '@/components/request-id-link';
import { OpsRunStatus } from '#trpc';
import { parseErrorTitle, prettyJson } from '../detail-payloads';
import { DetailBody, ErrorTitleCard } from '../detail-renderers';

type Severity = 'info' | 'notable' | 'warn' | 'critical';

const SEVERITY_TONE: Record<string, 'gray' | 'blue' | 'amber' | 'red'> = {
  info: 'gray',
  notable: 'blue',
  warn: 'amber',
  critical: 'red',
};

// OVI is the internal enum name for inbound WhatsApp — show the friendly label.
const TYPE_LABELS: Record<string, string> = { OVI: 'WhatsApp' };
function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

// Keyed by OpsRunStatus, not `string` — a new status must be given a tone here
// rather than silently falling through to gray, which is how `parked` would
// have arrived: a run waiting on a person rendered as if it had no state at all.
const STATUS_TONE: Record<OpsRunStatus, 'gray' | 'blue' | 'amber' | 'red' | 'emerald'> = {
  [OpsRunStatus.running]: 'blue',
  // Amber, not gray: a parked run is waiting on someone, so it wants a person's
  // eye — it just isn't a failure.
  [OpsRunStatus.parked]: 'amber',
  [OpsRunStatus.completed]: 'emerald',
  [OpsRunStatus.failed]: 'red',
};

function formatTimestamp(date: Date | string): string {
  return new Date(date).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function isEmptyRefs(refs: unknown): boolean {
  if (refs == null) return true;
  if (Array.isArray(refs)) return refs.length === 0;
  if (typeof refs === 'object') return Object.keys(refs).length === 0;
  return false;
}

// Acknowledgement, not a verdict: the badges beside it still say the run
// failed. Only a root event carries one — a step is dealt with by dealing with
// its run.
function ResolveControl({ id, resolvedAt }: { id: string; resolvedAt: Date | string | null }) {
  const utils = trpc.useUtils();
  const setResolved = trpc.views.ops.setResolved.useMutation({
    onSuccess: () => {
      void utils.views.ops.getEvent.invalidate({ id });
      void utils.views.ops.listFeed.invalidate();
      void utils.views.ops.summary.invalidate();
    },
  });

  if (resolvedAt) {
    return (
      <span className="ml-auto flex items-center gap-2">
        <Badge tone="emerald">Resolved</Badge>
        <span className="text-[12px] text-gray-400">{formatTimestamp(resolvedAt)}</span>
        <Button
          variant="ghost"
          size="sm"
          disabled={setResolved.isLoading}
          onClick={() => setResolved.mutate({ id, resolved: false })}
        >
          {setResolved.isLoading ? 'Undoing…' : 'Undo'}
        </Button>
      </span>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="ml-auto"
      disabled={setResolved.isLoading}
      onClick={() => setResolved.mutate({ id, resolved: true })}
    >
      {setResolved.isLoading ? 'Resolving…' : 'Mark resolved'}
    </Button>
  );
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = trpc.views.ops.getEvent.useQuery({ id });
  const { data: thread } = trpc.views.ops.listRunThread.useQuery(
    { runId: id },
    { enabled: !!data?.status },
  );

  const errorTitle = data?.title ? parseErrorTitle(data.title) : null;

  return (
    <>
      <PageHeader
        title={
          errorTitle ? (
            errorTitle.headline
          ) : data?.title ? (
            <EmojiText>{data.title}</EmojiText>
          ) : isLoading ? (
            'Loading…'
          ) : (
            'Event not found'
          )
        }
        actions={
          <ButtonLink href="/feed" variant="secondary" size="sm">
            ← Back to feed
          </ButtonLink>
        }
      />
      <PageBody width="wide">
        {isLoading ? (
          <p className="text-[13px] text-gray-400">Loading…</p>
        ) : !data ? (
          <p className="text-[13px] text-gray-500">
            Event not found.{' '}
            <Link href="/feed" className="underline">
              Return to feed.
            </Link>
          </p>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              {data.status && (
                <Badge tone={STATUS_TONE[data.status] ?? 'gray'}>{data.status}</Badge>
              )}
              <Badge tone={SEVERITY_TONE[data.severity as Severity] ?? 'gray'}>
                {data.severity}
              </Badge>
              <Badge tone="gray">{typeLabel(data.type)}</Badge>
              <span className="text-[12px] text-gray-400">
                {formatTimestamp(data.created_at)}
              </span>
              {(data.team_name || data.team_id) && (
                <span className="text-[12px] text-gray-400">
                  Team: {data.team_name ?? data.team_id}
                </span>
              )}
              {!data.parent_run_id && (
                <ResolveControl id={id} resolvedAt={data.resolved_at} />
              )}
            </div>

            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[12px]">
              {data.team_id && (
                <>
                  <dt className="font-medium uppercase tracking-wide text-gray-400">Team ID</dt>
                  <dd className="font-mono text-gray-600">{data.team_id}</dd>
                </>
              )}
              {data.request_id && (
                <>
                  <dt className="font-medium uppercase tracking-wide text-gray-400">Request ID</dt>
                  <dd className="flex flex-wrap items-center gap-2 font-mono text-gray-600">
                    {/* Raw UUID is for desktop; on mobile the link alone is enough. */}
                    <span className="hidden sm:inline">{data.request_id}</span>
                    <RequestIdLink requestId={data.request_id} className="text-[12px]" />
                  </dd>
                </>
              )}
            </dl>

            {errorTitle && (
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Error
                </p>
                <ErrorTitleCard payload={errorTitle.payload} />
              </div>
            )}

            {/* The page header truncates to one line, so a title-only event —
                run children and failed roots carry no detail at all — would
                otherwise lose its own text off the right edge. */}
            {!errorTitle && data.detail == null && (
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Message
                </p>
                <p className="text-[13px] leading-relaxed text-gray-700 whitespace-pre-wrap break-words">
                  <EmojiText>{data.title}</EmojiText>
                </p>
              </div>
            )}

            {!isEmptyRefs(data.entity_refs) && (
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Entity refs
                </p>
                <pre className="overflow-x-auto rounded-lg border border-gray-100 bg-gray-50 p-4 text-[12px] text-gray-700">
                  {prettyJson(data.entity_refs)}
                </pre>
              </div>
            )}

            {data.detail != null && (
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Detail
                </p>
                <DetailBody eventId={id} detail={data.detail} />
              </div>
            )}

            {thread && thread.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  Run thread
                </p>
                <ol className="space-y-2">
                  {thread.map((item) => (
                    <li key={item.id} className="flex items-start gap-3 text-[13px]">
                      <span className="shrink-0 text-[12px] text-gray-400">
                        {formatTimestamp(item.created_at)}
                      </span>
                      <Badge tone={SEVERITY_TONE[item.severity] ?? 'gray'}>
                        {item.severity}
                      </Badge>
                      <span className="text-gray-700">
                        <EmojiText>{item.title}</EmojiText>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </PageBody>
    </>
  );
}
