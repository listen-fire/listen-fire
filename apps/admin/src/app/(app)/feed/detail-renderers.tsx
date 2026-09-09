'use client';

/**
 * One inspector per payload shape. Every ops event used to render as the same
 * pretty-printed blob; each shape here gets the reading it deserves —
 * user prose wraps, identifiers go mono, machine noise collapses.
 */

import { EmojiText } from '@/components/emoji-text';
import { Badge, Button } from '@/components/ui';
import { trpc } from '@/lib/trpc';
import {
  detectDetailKind,
  humanizeKey,
  isRecord,
  looksLikeCode,
  prettyJson,
  type ErrorTitle,
} from './detail-payloads';

const DL = 'grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[12px]';
const DT = 'font-medium uppercase tracking-wide text-gray-400';
const DD_PROSE = 'min-w-0 whitespace-pre-wrap break-words text-gray-700';
const DD_MONO = 'min-w-0 break-all font-mono text-gray-600';
const PRE = 'overflow-x-auto rounded-lg border border-gray-100 bg-gray-50 p-4 text-[12px] text-gray-700';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className={DT}>{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

// ─── Per-kind bodies ──────────────────────────────────────────────────

function SlackDetail({ text, blocks }: { text: string; blocks: unknown }) {
  return (
    <>
      <p className="text-[13px] leading-relaxed text-gray-700 whitespace-pre-wrap break-words">
        <EmojiText>{text}</EmojiText>
      </p>
      {blocks != null && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-gray-400 hover:text-gray-600">
            Slack blocks
          </summary>
          <pre className={`mt-2 ${PRE}`}>{prettyJson(blocks)}</pre>
        </details>
      )}
    </>
  );
}

/** The English rendering sits under its source, never in place of it — the
 *  reporter's own words stay the record. */
function Translated({ text }: { text: string }) {
  return (
    <div className="mt-2 border-l-2 border-gray-100 pl-3">
      <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
        English
      </p>
      <p className={DD_PROSE}>{text}</p>
    </div>
  );
}

function FeedbackDetail({
  eventId,
  goal,
  friction,
  reporterEmail,
  source,
}: {
  eventId: string;
  goal: string;
  friction: string;
  reporterEmail: string | null;
  source: string | null;
}) {
  const translate = trpc.views.ops.translateEvent.useMutation();

  return (
    <>
      <dl className={DL}>
        <Row label="Goal">
          <p className={DD_PROSE}>{goal}</p>
          {translate.data && <Translated text={translate.data.goal} />}
        </Row>
        <Row label="Friction">
          <p className={DD_PROSE}>{friction}</p>
          {translate.data && <Translated text={translate.data.friction} />}
        </Row>
        {reporterEmail && (
          <Row label="Reporter">
            <a href={`mailto:${reporterEmail}`} className={`${DD_MONO} underline`}>
              {reporterEmail}
            </a>
          </Row>
        )}
        {source && (
          <Row label="Source">
            <Badge tone="gray">{source}</Badge>
          </Row>
        )}
      </dl>
      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={translate.isLoading}
          onClick={() => translate.mutate({ id: eventId })}
        >
          {translate.isLoading
            ? 'Translating…'
            : translate.data
              ? 'Translate again'
              : 'Translate'}
        </Button>
        {translate.error && (
          <span className="text-[12px] text-red-600">{translate.error.message}</span>
        )}
      </div>
    </>
  );
}

function MilestoneDetail({
  milestone,
  userId,
  teamId,
  tool,
}: {
  milestone: string;
  userId: string | null;
  teamId: string | null;
  tool: string | null;
}) {
  return (
    <dl className={DL}>
      <Row label="Milestone">
        <span className={DD_MONO}>{milestone}</span>
      </Row>
      {userId && (
        <Row label="User">
          <span className={DD_MONO}>{userId}</span>
        </Row>
      )}
      {teamId && (
        <Row label="Team">
          <span className={DD_MONO}>{teamId}</span>
        </Row>
      )}
      {tool && (
        <Row label="Tool">
          <span className={DD_MONO}>{tool}</span>
        </Row>
      )}
    </dl>
  );
}

/** Any payload we have no inspector for: still readable as key/value where the
 *  shape allows it, rather than a wall of braces. */
function UnknownDetail({ value }: { value: unknown }) {
  if (!isRecord(value)) return <pre className={PRE}>{prettyJson(value)}</pre>;
  const entries = Object.entries(value);
  if (entries.length === 0) return <pre className={PRE}>{prettyJson(value)}</pre>;
  return (
    <dl className={DL}>
      {entries.map(([key, entry]) => (
        <Row key={key} label={humanizeKey(key)}>
          {typeof entry === 'object' && entry !== null ? (
            <pre className={`${PRE} mt-0.5`}>{prettyJson(entry)}</pre>
          ) : typeof entry === 'string' && !looksLikeCode(entry) ? (
            <p className={DD_PROSE}>{entry}</p>
          ) : (
            <span className={DD_MONO}>{entry === null ? 'null' : String(entry)}</span>
          )}
        </Row>
      ))}
    </dl>
  );
}

export function DetailBody({ eventId, detail }: { eventId: string; detail: unknown }) {
  const shape = detectDetailKind(detail);
  switch (shape.kind) {
    case 'none':
      return null;
    case 'slack':
      return <SlackDetail text={shape.text} blocks={shape.blocks} />;
    case 'feedback':
      return (
        <FeedbackDetail
          eventId={eventId}
          goal={shape.goal}
          friction={shape.friction}
          reporterEmail={shape.reporterEmail}
          source={shape.source}
        />
      );
    case 'milestone':
      return (
        <MilestoneDetail
          milestone={shape.milestone}
          userId={shape.userId}
          teamId={shape.teamId}
          tool={shape.tool}
        />
      );
    case 'unknown':
      return <UnknownDetail value={shape.value} />;
  }
}

// ─── Error titles ─────────────────────────────────────────────────────

export function ErrorTitleCard({ payload }: { payload: ErrorTitle['payload'] }) {
  const message = typeof payload.message === 'string' ? payload.message : null;
  const rest = Object.entries(payload).filter(([key]) => !(key === 'message' && message));
  return (
    <div className="rounded-lg border border-red-100 bg-red-50/60 p-4">
      {message && (
        <p className="text-[13px] leading-relaxed text-red-900 whitespace-pre-wrap break-words">
          {message}
        </p>
      )}
      {rest.length > 0 && (
        <dl className={`${DL} ${message ? 'mt-3' : ''}`}>
          {rest.map(([key, value]) => (
            <Row key={key} label={humanizeKey(key)}>
              {typeof value === 'object' && value !== null ? (
                <pre className={`${PRE} mt-0.5`}>{prettyJson(value)}</pre>
              ) : looksLikeCode(value) ? (
                <span className="min-w-0 break-all font-mono text-red-800">
                  {value === null ? 'null' : String(value)}
                </span>
              ) : (
                <p className="min-w-0 whitespace-pre-wrap break-words text-red-900">
                  {String(value)}
                </p>
              )}
            </Row>
          ))}
        </dl>
      )}
    </div>
  );
}
