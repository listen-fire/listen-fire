"use client";

/**
 * Shared chrome for the funding history feed — ported near-verbatim from
 * apps/app's FundingSection/common.tsx (V-20). Chakra's Card/Grid/Accordion/
 * Menu/Popover become Tailwind divs plus two tiny local behaviours (an
 * expand toggle and a click-outside dropdown); the money/asset maps and the
 * price-line derivation are copied unchanged because they drive what the
 * numbers on screen mean.
 *
 * Dropped from the original: the dev-mode model-id popover (and with it the
 * `modelId` prop, which had no other consumer), and the attachments column of
 * RelatedNumbers' callers — `getEventHistory` no longer returns resources.
 */

import { useEffect, useReducer, useRef, useState } from "react";
import { useFormikContext } from "formik";
import {
  ArrowUp,
  Info,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { FormModal, FormSelect, TextArea, formatDate } from "@/components/portfolio";
import { buttonClass } from "@/components/ui";
import { trpc } from "@/lib/trpc";

import type { Price } from "./types";

import { AssetType, CurrencyIsoCode } from "#trpc";

// ─── Currency select ──────────────────────────────────────────────────
//
// apps/app's PortfolioList/CurrencySelect on top of its 558-LOC v2/Select.
// Rebuilt on the foundation's FormSelect; the currency list and its order
// are the original's.

const currencies = [
  CurrencyIsoCode.USD,
  CurrencyIsoCode.EUR,
  CurrencyIsoCode.GBP,
  CurrencyIsoCode.CHF,
  CurrencyIsoCode.NOK,
  CurrencyIsoCode.SEK,
  CurrencyIsoCode.DKK,
] satisfies CurrencyIsoCode[];

const currencyOptions = currencies.map((currency) => ({
  label: currency as string,
  value: currency,
}));

function CurrencySelect({
  value,
  onChange,
  placeholder = "Select currency",
}: {
  value?: CurrencyIsoCode | null;
  onChange: (value: CurrencyIsoCode | undefined) => void;
  placeholder?: string;
}) {
  return (
    <FormSelect<CurrencyIsoCode>
      value={currencyOptions.find((option) => option.value === value)}
      setValue={(option) => onChange(option?.value)}
      options={currencyOptions}
      placeholder={placeholder}
    />
  );
}

// ─── Formik helpers ───────────────────────────────────────────────────

function useResetFormOnClose({ isOpen }: { isOpen: boolean }) {
  const { resetForm } = useFormikContext();

  useEffect(() => {
    if (!isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  return null;
}

function ResetFormOnClose({ isOpen }: { isOpen: boolean }) {
  useResetFormOnClose({ isOpen });
  return null;
}

// ─── Tags ─────────────────────────────────────────────────────────────

function Tag({
  colour,
  children,
}: {
  colour?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded border px-2 py-1 text-[12px]"
      style={
        colour
          ? {
              backgroundColor: `${colour}10`,
              color: colour,
              borderColor: colour,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}

// ─── History item chrome ──────────────────────────────────────────────

function HistoryItemTitle({
  icon,
  title,
  tags,
  size,
}: {
  icon: React.ReactNode;
  title: string;
  tags?: React.ReactNode[];
  size?: "sm" | "lg";
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={
          size === "sm"
            ? "shrink-0 text-gray-700 [&_svg]:h-[18px] [&_svg]:w-[18px]"
            : "shrink-0 text-gray-700 [&_svg]:h-6 [&_svg]:w-6"
        }
      >
        {icon}
      </span>
      <span
        className={`font-semibold text-black ${size === "sm" ? "text-[16px]" : "text-[18px]"}`}
      >
        {title}
      </span>
      {tags?.length ? (
        <span className="ml-1.5 flex items-center gap-2">{tags}</span>
      ) : null}
    </div>
  );
}

function HistoryItemBox({
  title,
  children,
  stats,
  actions,
  infoLine,
  relatedNumbers,
  expandedContent,
  colourHue,
  size = "lg",
}: {
  title: React.ComponentProps<typeof HistoryItemTitle>;
  children?: React.ReactNode;
  stats?: React.ReactNode;
  actions?: React.ReactNode;
  infoLine?: React.ReactNode;
  relatedNumbers?: {
    attachments: number | null;
    notes: number | null;
    coinvestors: number | null;
    details?: boolean | null;
  };
  expandedContent?: React.ReactNode;
  colourHue?: number;
  size?: "sm" | "lg";
}) {
  // Chakra's <Accordion allowToggle> — RelatedNumbers was the AccordionButton,
  // so an item without relatedNumbers has no way to expand (as in the original).
  const [expanded, setExpanded] = useState(false);
  const onToggle = () => setExpanded((value) => !value);

  const cardStyle = {
    borderLeftWidth: "3px",
    borderLeftColor: colourHue
      ? `hsl(${colourHue}, 93%, 65%)`
      : "transparent",
  };

  const panel =
    expandedContent && expanded ? (
      <div className="px-5 pb-5 pt-2">{expandedContent}</div>
    ) : null;

  if (size === "sm") {
    return (
      <div
        className="group overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
        style={cardStyle}
      >
        <div className="flex items-center justify-between gap-5 px-5 py-3">
          <div className="flex min-w-0 shrink items-end gap-2 overflow-hidden">
            <HistoryItemTitle {...title} size={size} />
            {infoLine}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {relatedNumbers ? (
              <RelatedNumbers {...relatedNumbers} onToggle={onToggle} />
            ) : null}
            {actions}
          </div>
        </div>
        {panel}
      </div>
    );
  }

  return (
    <div
      className="group overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
      style={cardStyle}
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1 overflow-hidden">
            <HistoryItemTitle {...title} />
          </div>
          {stats ? (
            <div className="flex flex-wrap items-center gap-4">{stats}</div>
          ) : null}
          {actions ? (
            <div className="flex shrink-0 items-center justify-end gap-1">
              {actions}
            </div>
          ) : null}
        </div>
        {infoLine || relatedNumbers ? (
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">{infoLine}</div>
            {relatedNumbers ? (
              <div className="mr-1.5 flex flex-wrap">
                <RelatedNumbers {...relatedNumbers} onToggle={onToggle} />
              </div>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
      {panel}
    </div>
  );
}

function HistoryMoreButton({
  menuItems,
}: {
  menuItems: { label: string; icon: React.ReactNode; onClick: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentClick);
    return () => document.removeEventListener("mousedown", onDocumentClick);
  }, [open]);

  return (
    <div ref={ref} className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-label="More"
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-600"
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[200px] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] text-gray-700 hover:bg-gray-50 [&_svg]:h-4 [&_svg]:w-4"
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RelatedNumbers({
  attachments,
  notes,
  coinvestors,
  details,
  onToggle,
}: {
  attachments: number | null;
  notes: number | null;
  coinvestors: number | null;
  details?: boolean | null;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-6 shrink-0 grow cursor-pointer items-center gap-4 rounded-lg px-3 text-[13px] text-[#a2a2a2] shadow-[0_0_6px_hsl(0,0%,80%)] hover:shadow-[0_0_6px_#8778FA] sm:shadow-none sm:group-hover:shadow-[0_0_6px_hsl(0,0%,80%)]"
    >
      {coinvestors !== null ? (
        <span className="inline-flex items-center gap-1">
          <Users className="h-[18px] w-[18px]" /> {coinvestors}
        </span>
      ) : null}
      {details ? (
        <span className="inline-flex items-center gap-1">
          <Info className="h-[18px] w-[18px]" /> +
        </span>
      ) : null}
      {notes !== null ? (
        <span className="inline-flex items-center gap-1">
          <MessageCircle className="h-[18px] w-[18px]" /> {notes}
        </span>
      ) : null}
      {attachments !== null ? (
        <span className="inline-flex items-center gap-1">
          <Paperclip className="h-[18px] w-[18px]" /> {attachments}
        </span>
      ) : null}
    </button>
  );
}

// ─── Asset vocabulary ─────────────────────────────────────────────────

const AssetTypeMap: Record<AssetType, string> = {
  EQUITY: "Equity",
  CONVERTIBLE: "Convertible",
  SPV_INTEREST_POINT: "SPV",
  EMPLOYEE_STOCK_OPTIONS: "Employee Stock Options",
  CURRENCY: "Currency",
  EQUITY_UNKNOWN_SHARES: "Unknown Holding",
  LP_INTEREST_POINT: "Fund",
  FUND_OUTSTANDING_COMMITMENT: "Outstanding Commitment",
  ACCRUED_INCOME: "Accrued Income",
  UNKNOWN: "Unknown",
};

const AssetTypeColorMap: Record<AssetType, string> = {
  EQUITY: "#04a3d8",
  CONVERTIBLE: "#54BF22",
  SPV_INTEREST_POINT: "#bd00e3",
  EMPLOYEE_STOCK_OPTIONS: "#E38800",
  CURRENCY: "#ed4c4c",
  EQUITY_UNKNOWN_SHARES: "#ae5c5c",
  LP_INTEREST_POINT: "#6858e0",
  FUND_OUTSTANDING_COMMITMENT: "#bd00e3",
  ACCRUED_INCOME: "#bd00e3",
  UNKNOWN: "#bd00e3",
};

function priceLineKey(price: Pick<Price, "asset_id" | "type" | "name">) {
  return price.asset_id && price.type !== "EQUITY"
    ? `${price.name} (${AssetTypeMap[price.type ?? "UNKNOWN"]})`
    : "Price Per Share";
}

// ─── Notes ────────────────────────────────────────────────────────────

type Note = {
  id: string;
  content: string;
  creator: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}[];

/**
 * Notes written by apps/app were Lexical editor state, not text. The editor
 * is not ported (doc 5 §2.3), so new notes are plain text; legacy notes are
 * unwrapped by collecting the state tree's text nodes rather than showing
 * the raw JSON.
 */
function noteText(content: string): string {
  if (!content?.startsWith('{"root":')) {
    return content;
  }
  try {
    const lines: string[] = [];
    const walk = (node: unknown, into: string[]) => {
      if (!node || typeof node !== "object") return;
      const record = node as { text?: unknown; children?: unknown; type?: unknown };
      if (typeof record.text === "string") {
        into[into.length - 1] += record.text;
      }
      if (Array.isArray(record.children)) {
        if (record.type === "paragraph") into.push("");
        record.children.forEach((child) => walk(child, into));
      }
    };
    walk((JSON.parse(content) as { root?: unknown }).root, lines);
    return lines.join("\n").trim();
  } catch {
    return content;
  }
}

function NotesSection({
  notes,
  onAdd,
}: {
  notes?: Note | null;
  onAdd?: (text: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [editorVisible, setEditorVisible] = useState(false);

  const submit = async () => {
    await onAdd?.(note);
    setEditorVisible(false);
    setNote("");
  };

  return (
    <div className="flex flex-col items-stretch gap-2">
      <div className="flex items-center gap-3">
        <span className="text-[16px] font-semibold">Notes</span>
        <button
          type="button"
          onClick={() => setEditorVisible(!editorVisible)}
          className={buttonClass({
            variant: editorVisible ? "danger" : "secondary",
            size: "sm",
          })}
        >
          {editorVisible ? (
            <X className="h-3 w-3" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
          {editorVisible ? "Cancel" : "Add note"}
        </button>
      </div>
      <div className="flex flex-col items-stretch gap-1">
        {editorVisible ? (
          <div className="relative w-full max-w-full overflow-hidden rounded-lg border border-gray-200">
            <TextArea
              autoFocus
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Add a note..."
              className="border-0 focus:border-0"
            />
            <div className="flex justify-end p-1">
              <button
                type="button"
                aria-label="Save note"
                onClick={() => void submit()}
                className={buttonClass({ variant: "primary", size: "sm" })}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : null}
        {!notes?.length && !editorVisible ? (
          <span className="text-[14px] text-gray-400">No notes</span>
        ) : (
          notes
            ?.slice()
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
            )
            .map((item) => <NoteDisplay key={item.id} note={item} />)
        )}
      </div>
    </div>
  );
}

function NoteDisplay({ note }: { note: Note[number] }) {
  const utils = trpc.useUtils();
  const { mutateAsync: removeNote } =
    trpc.views.portfolio.company.deleteNote.useMutation();
  const [isOpen, toggle] = useReducer((open: boolean) => !open, false);

  return (
    <div className="group flex flex-col items-stretch gap-2 rounded-md bg-gray-50 p-3">
      <FormModal
        isOpen={isOpen}
        onClose={toggle}
        title="Are you sure?"
        footer={
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={toggle}
              className={buttonClass({ variant: "ghost" })}
            >
              Cancel
            </button>
            <button
              type="button"
              className={buttonClass({ variant: "danger" })}
              onClick={async () => {
                await removeNote({ noteId: note.id });
                utils.views.portfolio.company.getEventHistory.invalidate();
                toggle();
              }}
            >
              Delete
            </button>
          </div>
        }
      >
        <p className="text-[13px] text-gray-600">
          This action cannot be undone. This will permanently delete the note.
        </p>
      </FormModal>
      <div className="flex items-center gap-2 text-[13px]">
        <MessageCircle className="h-4 w-4 text-gray-500" />
        <span className="font-medium text-gray-600">{note.creator}</span>
        <span className="h-1 w-1 rounded-full bg-gray-300" />
        <span className="text-gray-400">
          {formatDate(new Date(note.createdAt), "dd MMM yyyy")}
        </span>
        <button
          type="button"
          aria-label="Delete note"
          onClick={toggle}
          className="ml-auto hidden text-red-500 group-hover:block"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="whitespace-pre-wrap text-[13px] text-gray-800">
        {noteText(note.content)}
      </p>
    </div>
  );
}

export {
  HistoryItemBox,
  HistoryMoreButton,
  HistoryItemTitle,
  priceLineKey,
  AssetTypeMap,
  AssetTypeColorMap,
  NotesSection,
  CurrencySelect,
  ResetFormOnClose,
  Tag,
  currencyOptions,
};
