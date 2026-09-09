"use client";

// Shared rendering for one ask/question record — used by both the Inbox
// (open questions, answered in place) and History (settled questions,
// read-only) pages so the row looks identical in both places.

import { Clock, MessageCircleQuestion } from "lucide-react";

import { type RouterOutputs } from "@/lib/trpc";
import { AskControl, type AskControlData } from "@/components/asks/ask-controls";
import { Badge } from "@/components/ui";

export type AskRecord =
  RouterOutputs["views"]["controlTower"]["listAskRecords"][number];

export function sinceLabel(date: string | Date): string {
  const d = new Date(date);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Project a question into the shared answer-control shape. The control submits
 *  the same structured payload the link page does (a boolean for Check, the
 *  chosen ids for Select, `{ rows, dropped }` for Correct). */
function questionToControlData(q: AskRecord): AskControlData {
  return {
    interactionType: q.interactionType,
    resultType: q.resultType,
    title: q.question,
    detail: q.detail ?? undefined,
    options: q.options,
    correct: q.correct,
  };
}

/** A settled answer, in one plain line. */
function settledAnswerLabel(q: AskRecord): string {
  const a = q.answer;
  if (q.state === "expired") return "No longer needed";
  if (typeof a === "boolean") {
    return q.interactionType === "check" ? (a ? "Approved" : "Declined") : a ? "Yes" : "No";
  }
  if (a === "ack") return "Acknowledged";
  if (typeof a === "string") return a;
  if (typeof a === "number") return String(a);
  if (Array.isArray(a)) return a.length === 0 ? "Nothing selected" : a.join(", ");
  if (a && typeof a === "object") return "Recorded";
  return "Answered";
}

/** One question. Open ones answer in place; settled ones show the decision.
 *  Copy is plain — never "ask" / "adapter". */
export function QuestionRow({
  q,
  onAnswer,
  busy,
}: {
  q: AskRecord;
  onAnswer: (answer: unknown) => void;
  busy: boolean;
}) {
  const settled = q.state !== "open";
  return (
    <div className="rounded-lg border border-gray-100 bg-white p-3">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion size={15} className="mt-0.5 shrink-0 text-gray-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-gray-800">{q.question}</span>
            {settled && (
              <Badge tone={q.state === "answered" ? "emerald" : "gray"}>
                {q.state === "answered" ? "Answered" : "Closed"}
              </Badge>
            )}
          </div>
          {q.detail && (
            <div className="mt-0.5 text-[12px] leading-relaxed text-gray-500">{q.detail}</div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-gray-400">
            <span className="inline-flex items-center gap-1">
              <Clock size={11} /> {settled ? "asked" : "waiting since"} {sinceLabel(q.createdAt)}
            </span>
            {q.awaitingAutomationName && (
              <>
                <span className="text-gray-300">·</span>
                <span>{q.awaitingAutomationName} is waiting</span>
              </>
            )}
          </div>
        </div>
      </div>
      {settled ? (
        <div className="mt-2 pl-7 text-[12px] text-gray-500">{settledAnswerLabel(q)}</div>
      ) : (
        <div className="mt-2 pl-7">
          <div className="text-[11px] font-medium uppercase tracking-wide text-gray-300">
            Answer
          </div>
          <div className="mt-1.5">
            <AskControl
              ask={questionToControlData(q)}
              submitting={busy}
              variant="inline"
              onSubmit={(answer) => onAnswer(answer)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
