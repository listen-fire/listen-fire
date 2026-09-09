"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Filter,
  Plus,
  X,
  Sparkles,
  Loader2,
  Group,
  Search,
} from "lucide-react";

export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_empty"
  | "is_not_empty"
  | "in";

export type FilterConjunction = "and" | "or";

export interface TableFilter {
  id: string;
  columnId: string;
  operator: FilterOperator;
  value?: string | number | boolean | null;
  values?: string[];
  negated?: boolean;
}

export interface FilterGroup {
  id: string;
  conjunction: FilterConjunction;
  filters: TableFilter[];
}

/** A top-level filter expression item — either a single filter or a group */
export type FilterItem = TableFilter | FilterGroup;

export function isFilterGroup(item: FilterItem): item is FilterGroup {
  return "filters" in item;
}

export interface ColumnDef {
  id: string;
  name: string;
  value_type: string;
  enum_values?: string[] | null;
}

const OPERATORS_BY_TYPE: Record<
  string,
  { value: FilterOperator; label: string }[]
> = {
  text: [
    { value: "contains", label: "contains" },
    { value: "not_contains", label: "not contains" },
    { value: "eq", label: "is" },
    { value: "neq", label: "is not" },
    { value: "starts_with", label: "starts with" },
    { value: "ends_with", label: "ends with" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ],
  number: [
    { value: "eq", label: "=" },
    { value: "neq", label: "≠" },
    { value: "gt", label: ">" },
    { value: "gte", label: "≥" },
    { value: "lt", label: "<" },
    { value: "lte", label: "≤" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ],
  date: [
    { value: "eq", label: "is" },
    { value: "gt", label: "after" },
    { value: "lt", label: "before" },
    { value: "gte", label: "on or after" },
    { value: "lte", label: "on or before" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ],
  boolean: [
    { value: "eq", label: "is" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ],
  enum: [
    { value: "eq", label: "is" },
    { value: "neq", label: "is not" },
    { value: "in", label: "is any of" },
    { value: "is_empty", label: "is empty" },
    { value: "is_not_empty", label: "is not empty" },
  ],
  _search: [{ value: "contains", label: "contains" }],
};

function getOperatorsForColumn(col: ColumnDef) {
  if (col.id === "_search") return OPERATORS_BY_TYPE._search;
  if (Array.isArray(col.enum_values) && col.enum_values.length > 0)
    return OPERATORS_BY_TYPE.enum;
  return OPERATORS_BY_TYPE[col.value_type] ?? OPERATORS_BY_TYPE.text;
}

function operatorNeedsValue(op: FilterOperator): boolean {
  return op !== "is_empty" && op !== "is_not_empty";
}

function operatorLabel(op: FilterOperator, col: ColumnDef): string {
  const ops = getOperatorsForColumn(col);
  return ops.find((o) => o.value === op)?.label ?? op;
}

function formatFilterValue(filter: TableFilter, col?: ColumnDef): string {
  if (!operatorNeedsValue(filter.operator)) return "";
  if (filter.operator === "in" && filter.values)
    return filter.values.join(", ");
  if (filter.value === null || filter.value === undefined) return "";
  if (col?.value_type === "boolean") return filter.value ? "Yes" : "No";
  if (col?.value_type === "date" && typeof filter.value === "string") {
    return new Date(filter.value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  return String(filter.value);
}

let nextFilterId = 1;
function genId() {
  return `f${nextFilterId++}`;
}

// --- Progressive pill builder: column → operator → value, inline ---

type BuilderStep = "column" | "operator" | "value";

function PillBuilder({
  columns,
  onCommit,
  onCancel,
  onBackspaceEmpty,
  onNlSubmit,
  initialFilter,
}: {
  columns: ColumnDef[];
  onCommit: (filter: TableFilter) => void;
  onCancel: () => void;
  onBackspaceEmpty?: () => void;
  onNlSubmit?: (query: string) => void;
  initialFilter?: TableFilter;
}) {
  const [step, setStep] = useState<BuilderStep>(
    initialFilter ? (operatorNeedsValue(initialFilter.operator) ? "value" : "operator") : "column",
  );
  const [negated, setNegated] = useState(initialFilter?.negated ?? false);
  const [columnId, setColumnId] = useState<string | null>(initialFilter?.columnId ?? null);
  const [operator, setOperator] = useState<FilterOperator | null>(initialFilter?.operator ?? null);
  const [value, setValue] = useState(
    initialFilter?.value != null ? String(initialFilter.value) : "",
  );
  const [values, setValues] = useState<string[]>(initialFilter?.values ?? []);
  const [dropdownOpen, setDropdownOpen] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLSpanElement>(null);

  const col = columns.find((c) => c.id === columnId);
  const operators = col ? getOperatorsForColumn(col) : [];

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onCancel();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onCancel]);

  // Focus input when step changes
  useEffect(() => {
    if (step === "value") {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [step]);

  // Auto-open dropdown when entering column or operator step
  useEffect(() => {
    setDropdownOpen(true);
    setFilterText("");
    setHighlightIndex(0);
  }, [step]);

  // Reset highlight when filter text changes
  useEffect(() => {
    setHighlightIndex(0);
  }, [filterText]);

  // Auto-size: ~7px per char at 12px font, min 80px, max 400px
  const inputText = step === "value" ? value : filterText;
  const placeholderLen = step === "column" ? 10 : step === "operator" ? 10 : 6;
  const inputWidth = Math.max(80, Math.min(400, (inputText.length || placeholderLen) * 7.2 + 16));

  function selectColumn(id: string) {
    setColumnId(id);
    setStep("operator");
  }

  function selectOperator(op: FilterOperator) {
    setOperator(op);
    if (!operatorNeedsValue(op)) {
      // No value needed — commit immediately
      onCommit({
        id: genId(),
        columnId: columnId!,
        operator: op,
        negated: negated || undefined,
      });
    } else {
      setStep("value");
    }
  }

  function commitValue() {
    if (!columnId || !operator) return;
    const f: TableFilter = {
      id: genId(),
      columnId,
      operator,
      negated: negated || undefined,
    };
    if (operator === "in") {
      f.values =
        values.length > 0
          ? values
          : value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean);
    } else if (col?.value_type === "number") {
      f.value = value ? parseFloat(value) : null;
    } else if (col?.value_type === "boolean") {
      f.value = value === "true";
    } else {
      f.value = value || null;
    }
    onCommit(f);
  }

  // Filtered columns for column step
  const filteredColumns = filterText
    ? columns.filter((c) =>
        c.name.toLowerCase().includes(filterText.toLowerCase()),
      )
    : columns;

  // When typing in column step, prepend quick-search and AI options
  const hasSearchShortcut = step === "column" && filterText.trim().length > 0;
  const hasNlShortcut =
    step === "column" &&
    filterText.trim().length > 0 &&
    !!onNlSubmit;
  // Extra items prepended to the column dropdown
  const extraItems = (hasSearchShortcut ? 1 : 0) + (hasNlShortcut ? 1 : 0);

  const filteredOperators = filterText
    ? operators.filter((o) =>
        o.label.toLowerCase().includes(filterText.toLowerCase()) ||
        (negated ? "not" : "").includes(filterText.toLowerCase()),
      )
    : operators;
  // "NOT" toggle is the first item in the operator dropdown
  const operatorExtraItems = step === "operator" ? 1 : 0;

  function commitSearchShortcut() {
    onCommit({
      id: genId(),
      columnId: "_search",
      operator: "contains",
      value: filterText.trim(),
      negated: negated || undefined,
    });
  }

  function commitNlShortcut() {
    if (!onNlSubmit) return;
    onNlSubmit(filterText.trim());
  }

  return (
    <div ref={containerRef} className="relative flex items-center">
      <span ref={sizerRef} className="invisible absolute whitespace-pre text-[12px]" />
      <div className="flex items-center rounded-md border border-primary/30 bg-white text-[12px] shadow-sm">
        {/* Negation badge (shown when active) */}
        {negated && (
          <button
            type="button"
            onClick={() => setNegated(false)}
            className="rounded-l-md border-r border-red-200 bg-red-50 px-1.5 py-1 text-[10px] font-semibold uppercase text-red-500 hover:bg-red-100"
            title="Remove negation"
          >
            NOT
          </button>
        )}

        {/* Column segment (completed) */}
        {col && (
          <button
            type="button"
            onClick={() => {
              setStep("column");
              setColumnId(null);
              setOperator(null);
            }}
            className="border-r border-gray-200 px-2 py-1 font-medium text-gray-900 hover:bg-gray-50"
          >
            {col.name}
          </button>
        )}

        {/* Operator segment (completed) */}
        {operator && col && (
          <button
            type="button"
            onClick={() => {
              setStep("operator");
              setOperator(null);
            }}
            className="border-r border-gray-200 px-2 py-1 text-gray-500 hover:bg-gray-50"
          >
            {operatorLabel(operator, col)}
          </button>
        )}

        {/* Active step: column or operator dropdown trigger */}
        {(step === "column" || step === "operator") && (
          <div className="relative">
            <input
              autoFocus
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              onFocus={() => setDropdownOpen(true)}
              placeholder={step === "column" ? "Property..." : "Operator..."}
              style={{ width: inputWidth }}
              className="bg-transparent px-2 py-1 text-[12px] placeholder:text-gray-400 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Escape") onCancel();
                if (e.key === "Backspace" && !filterText) {
                  if (step === "operator") {
                    setStep("column");
                    setColumnId(null);
                    setOperator(null);
                  } else if (step === "column") {
                    onBackspaceEmpty?.();
                  }
                  return;
                }
                const listItems =
                  step === "column" ? filteredColumns : filteredOperators;
                const extraOffset = step === "column" ? extraItems : operatorExtraItems;
                const totalItems = listItems.length + extraOffset;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlightIndex((i) => Math.min(i + 1, totalItems - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlightIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  if (step === "column") {
                    if (hasSearchShortcut && highlightIndex === 0) {
                      commitSearchShortcut();
                    } else if (hasNlShortcut && highlightIndex === (hasSearchShortcut ? 1 : 0)) {
                      commitNlShortcut();
                    } else {
                      const colIdx = highlightIndex - extraItems;
                      if (filteredColumns.length > 0)
                        selectColumn(
                          filteredColumns[colIdx]?.id ?? filteredColumns[0].id,
                        );
                    }
                  }
                  if (step === "operator") {
                    if (highlightIndex === 0) {
                      // NOT toggle
                      setNegated(!negated);
                    } else if (filteredOperators.length > 0) {
                      const opIdx = highlightIndex - operatorExtraItems;
                      selectOperator(
                        filteredOperators[opIdx]?.value ??
                          filteredOperators[0].value,
                      );
                    }
                  }
                }
              }}
            />
          </div>
        )}

        {/* Active step: value input */}
        {step === "value" &&
          col &&
          (col.value_type === "boolean" ||
          (Array.isArray(col.enum_values) &&
            col.enum_values.length > 0 &&
            operator !== "in") ? (
            <input
              autoFocus
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              onFocus={() => setDropdownOpen(true)}
              placeholder="Value..."
              style={{ width: inputWidth }}
              className="bg-transparent px-2 py-1 text-[12px] placeholder:text-gray-400 focus:outline-none"
              onKeyDown={(e) => {
                const opts =
                  col.value_type === "boolean"
                    ? [
                        { key: "true", label: "Yes" },
                        { key: "false", label: "No" },
                      ]
                    : (col.enum_values ?? [])
                        .filter(
                          (ev) =>
                            !filterText ||
                            ev.toLowerCase().includes(filterText.toLowerCase()),
                        )
                        .map((ev) => ({ key: ev, label: ev }));
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlightIndex((i) => Math.min(i + 1, opts.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlightIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === "Backspace" && !filterText) {
                  setStep("operator");
                  setOperator(null);
                } else if (e.key === "Enter" && opts.length > 0) {
                  const pick = opts[highlightIndex] ?? opts[0];
                  onCommit({
                    id: genId(),
                    columnId: columnId!,
                    operator: operator!,
                    value:
                      col.value_type === "boolean"
                        ? pick.key === "true"
                        : pick.key,
                    negated: negated || undefined,
                  });
                } else if (e.key === "Escape") onCancel();
              }}
            />
          ) : (
            <input
              ref={inputRef}
              type={
                col.value_type === "number"
                  ? "number"
                  : col.value_type === "date"
                    ? "date"
                    : "text"
              }
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Value..."
              style={{ width: inputWidth }}
              className="bg-transparent px-2 py-1 text-[12px] text-gray-700 placeholder:text-gray-400 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !value) {
                  setStep("operator");
                  setOperator(null);
                  return;
                }
                if (e.key === "Enter") commitValue();
                if (e.key === "Escape") onCancel();
              }}
            />
          ))}

        {/* Cancel */}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-r-md px-1.5 py-1 text-gray-400 hover:text-gray-600"
        >
          <X size={12} />
        </button>
      </div>

      {/* Dropdown */}
      {dropdownOpen &&
        (step === "column" ||
          step === "operator" ||
          (step === "value" &&
            col &&
            ((Array.isArray(col.enum_values) && col.enum_values.length > 0) ||
              col.value_type === "boolean"))) && (
          <div
            ref={listRef}
            className="absolute left-0 top-full z-50 mt-1 max-h-60 min-w-[240px] overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg"
          >
            {step === "column" && (
              <>
                {hasSearchShortcut && (
                  <button
                    key="_search_shortcut"
                    type="button"
                    ref={(el) => {
                      if (0 === highlightIndex && el)
                        el.scrollIntoView({ block: "nearest" });
                    }}
                    onClick={commitSearchShortcut}
                    onMouseEnter={() => setHighlightIndex(0)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-gray-700 ${
                      0 === highlightIndex ? "bg-gray-100" : ""
                    }`}
                  >
                    <Search size={11} className="text-gray-400" />
                    <span className="text-gray-500">Search</span>
                    <span className="font-medium text-gray-900">
                      &ldquo;{filterText.trim()}&rdquo;
                    </span>
                  </button>
                )}
                {hasNlShortcut && (() => {
                  const nlIdx = hasSearchShortcut ? 1 : 0;
                  return (
                    <button
                      key="_nl_shortcut"
                      type="button"
                      ref={(el) => {
                        if (nlIdx === highlightIndex && el)
                          el.scrollIntoView({ block: "nearest" });
                      }}
                      onClick={commitNlShortcut}
                      onMouseEnter={() => setHighlightIndex(nlIdx)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-gray-700 ${
                        nlIdx === highlightIndex ? "bg-gray-100" : ""
                      }`}
                    >
                      <Sparkles size={11} className="text-primary/60" />
                      <span className="text-gray-500">AI filter</span>
                      <span className="font-medium text-gray-900">
                        &ldquo;{filterText.trim()}&rdquo;
                      </span>
                    </button>
                  );
                })()}
                {(hasSearchShortcut || hasNlShortcut) && filteredColumns.length > 0 && (
                  <div className="my-1 border-t border-gray-100" />
                )}
                {filteredColumns.map((c, idx) => {
                  const itemIdx = idx + extraItems;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      ref={(el) => {
                        if (itemIdx === highlightIndex && el)
                          el.scrollIntoView({ block: "nearest" });
                      }}
                      onClick={() => selectColumn(c.id)}
                      onMouseEnter={() => setHighlightIndex(itemIdx)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-gray-700 ${
                        itemIdx === highlightIndex ? "bg-gray-100" : ""
                      }`}
                    >
                      {c.id === "_search" && (
                        <Search size={11} className="text-gray-400" />
                      )}
                      <span
                        className={
                          c.id === "_search" ? "text-gray-500 italic" : ""
                        }
                      >
                        {c.name}
                      </span>
                      {c.id !== "_search" && (
                        <span className="ml-auto text-[10px] text-gray-400">
                          {c.value_type}
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}
            {step === "operator" && (
              <>
                <button
                  key="_not_toggle"
                  type="button"
                  ref={(el) => {
                    if (0 === highlightIndex && el)
                      el.scrollIntoView({ block: "nearest" });
                  }}
                  onClick={() => setNegated(!negated)}
                  onMouseEnter={() => setHighlightIndex(0)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                    0 === highlightIndex ? "bg-gray-100" : ""
                  } ${negated ? "text-red-600" : "text-gray-500"}`}
                >
                  <span
                    className={`flex h-3.5 w-3.5 items-center justify-center rounded border text-[9px] font-bold ${
                      negated
                        ? "border-red-300 bg-red-50 text-red-500"
                        : "border-gray-300"
                    }`}
                  >
                    {negated && "✓"}
                  </span>
                  NOT
                </button>
                <div className="my-0.5 border-t border-gray-100" />
                {filteredOperators.map((o, idx) => {
                  const itemIdx = idx + operatorExtraItems;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      ref={(el) => {
                        if (itemIdx === highlightIndex && el)
                          el.scrollIntoView({ block: "nearest" });
                      }}
                      onClick={() => selectOperator(o.value)}
                      onMouseEnter={() => setHighlightIndex(itemIdx)}
                      className={`flex w-full items-center px-3 py-1.5 text-left text-[12px] text-gray-700 ${
                        itemIdx === highlightIndex ? "bg-gray-100" : ""
                      }`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </>
            )}
            {step === "value" &&
              col &&
              operator === "in" &&
              Array.isArray(col.enum_values) &&
              col.enum_values.length > 0 && (
                <>
                  {col.enum_values.map((ev) => {
                    const selected = values.includes(ev);
                    return (
                      <button
                        key={ev}
                        type="button"
                        onClick={() =>
                          setValues((prev) =>
                            selected
                              ? prev.filter((v) => v !== ev)
                              : [...prev, ev],
                          )
                        }
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-gray-100 ${
                          selected
                            ? "text-primary font-medium"
                            : "text-gray-700"
                        }`}
                      >
                        <span
                          className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                            selected
                              ? "border-primary bg-primary text-white"
                              : "border-gray-300"
                          }`}
                        >
                          {selected && (
                            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5">
                              <path
                                d="M2 6l3 3 5-5"
                                stroke="currentColor"
                                strokeWidth="2"
                                fill="none"
                              />
                            </svg>
                          )}
                        </span>
                        {ev}
                      </button>
                    );
                  })}
                  {values.length > 0 && (
                    <div className="border-t border-gray-100 px-3 py-1.5">
                      <button
                        type="button"
                        onClick={commitValue}
                        className="w-full rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-white hover:bg-primary-600"
                      >
                        Apply ({values.length})
                      </button>
                    </div>
                  )}
                </>
              )}
            {step === "value" &&
              col &&
              operator !== "in" &&
              (() => {
                const opts =
                  col.value_type === "boolean"
                    ? [
                        { key: "true", label: "Yes" },
                        { key: "false", label: "No" },
                      ]
                    : (col.enum_values ?? [])
                        .filter(
                          (ev) =>
                            !filterText ||
                            ev.toLowerCase().includes(filterText.toLowerCase()),
                        )
                        .map((ev) => ({ key: ev, label: ev }));
                if (opts.length === 0) return null;
                return opts.map((opt, idx) => (
                  <button
                    key={opt.key}
                    type="button"
                    ref={(el) => {
                      if (idx === highlightIndex && el)
                        el.scrollIntoView({ block: "nearest" });
                    }}
                    onClick={() => {
                      onCommit({
                        id: genId(),
                        columnId: columnId!,
                        operator: operator!,
                        value:
                          col.value_type === "boolean"
                            ? opt.key === "true"
                            : opt.key,
                        negated: negated || undefined,
                      });
                    }}
                    onMouseEnter={() => setHighlightIndex(idx)}
                    className={`flex w-full items-center px-3 py-1.5 text-left text-[12px] text-gray-700 ${
                      idx === highlightIndex ? "bg-gray-100" : ""
                    }`}
                  >
                    {opt.label}
                  </button>
                ));
              })()}
          </div>
        )}
    </div>
  );
}

// --- Filter chip (completed filter) ---

function FilterChip({
  filter,
  columns,
  onEdit,
  onRemove,
}: {
  filter: TableFilter;
  columns: ColumnDef[];
  onEdit: () => void;
  onRemove: () => void;
}) {
  const col = columns.find((c) => c.id === filter.columnId);
  const colName = col?.name ?? filter.columnId;
  const opLabel = col ? operatorLabel(filter.operator, col) : filter.operator;
  const valDisplay = formatFilterValue(filter, col);

  return (
    <span
      className={`group/chip inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] transition-colors ${
        filter.negated
          ? "border-red-200 bg-red-50/50 text-gray-700 hover:border-red-300"
          : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
      }`}
    >
      {filter.negated && (
        <span className="text-[10px] font-semibold text-red-500">NOT</span>
      )}
      <button
        type="button"
        onClick={onEdit}
        className="flex items-center gap-1"
      >
        <span className="font-medium text-gray-900">{colName}</span>
        <span className="text-gray-400">{opLabel}</span>
        {valDisplay && (
          <span className="max-w-[120px] truncate text-gray-700">
            {valDisplay}
          </span>
        )}
      </button>
      <X
        size={12}
        className="shrink-0 cursor-pointer text-gray-400 transition-colors hover:text-gray-700"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      />
    </span>
  );
}

// --- Group chip: renders (A or B or C) as a visual group ---

function GroupChips({
  group,
  columns,
  onEditFilter,
  onRemoveFilter,
  onToggleGroupConjunction,
  onUngroup,
}: {
  group: FilterGroup;
  columns: ColumnDef[];
  onEditFilter: (filterIndex: number) => void;
  onRemoveFilter: (filterIndex: number) => void;
  onToggleGroupConjunction: () => void;
  onUngroup: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-gray-300 bg-gray-50/50 px-1.5 py-0.5">
      <span className="text-[10px] text-gray-400">(</span>
      {group.filters.map((filter, i) => (
        <span key={filter.id} className="inline-flex items-center gap-1">
          {i > 0 &&
            (i === 1 ? (
              <button
                type="button"
                onClick={onToggleGroupConjunction}
                className="shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold uppercase text-primary/70 transition-colors hover:bg-primary/10"
              >
                {group.conjunction}
              </button>
            ) : (
              <span className="shrink-0 text-[10px] font-semibold uppercase text-gray-400">
                {group.conjunction}
              </span>
            ))}
          <FilterChip
            filter={filter}
            columns={columns}
            onEdit={() => onEditFilter(i)}
            onRemove={() => onRemoveFilter(i)}
          />
        </span>
      ))}
      <span className="text-[10px] text-gray-400">)</span>
      <button
        type="button"
        onClick={onUngroup}
        title="Ungroup"
        className="ml-0.5 shrink-0 rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
      >
        <X size={10} />
      </button>
    </span>
  );
}

// --- Main filter bar ---

export interface TableFilterBarHandle {
  startBuilding: () => void;
}

export const TableFilterBar = forwardRef<
  TableFilterBarHandle,
  {
    columns: ColumnDef[];
    items: FilterItem[];
    conjunction: FilterConjunction;
    onChange: (items: FilterItem[]) => void;
    onConjunctionChange: (conjunction: FilterConjunction) => void;
    onParseNaturalLanguage?: (
      query: string,
    ) => Promise<
      Array<
        Omit<TableFilter, "id"> & {
          group?: {
            conjunction: "and" | "or";
            filters: Omit<TableFilter, "id">[];
          };
        }
      >
    >;
  }
>(function TableFilterBar(
  {
    columns,
    items,
    conjunction,
    onChange,
    onConjunctionChange,
    onParseNaturalLanguage,
  },
  ref,
) {
  const [building, setBuilding] = useState(false);
  const [builderKey, setBuilderKey] = useState(0);
  const [nlProcessing, setNlProcessing] = useState<string | null>(null);
  useImperativeHandle(ref, () => ({
    startBuilding: () => {
      setBuilding(true);
      setBuilderKey((k) => k + 1);
    },
  }));

  const handleNlFromBuilder = useCallback(
    (query: string) => {
      if (!onParseNaturalLanguage) return;
      setBuilding(false);
      setNlProcessing(query);
      onParseNaturalLanguage(query).then((parsed) => {
        if (parsed.length > 0) {
          const newItems: FilterItem[] = parsed.map((f): FilterItem => {
            if (f.group) {
              return {
                id: genId(),
                conjunction: f.group.conjunction,
                filters: f.group.filters.map((gf) => ({
                  ...gf,
                  id: genId(),
                })),
              } as FilterGroup;
            }
            return { ...f, id: genId() } as TableFilter;
          });
          onChange([...items, ...newItems]);
        }
        setNlProcessing(null);
        setBuilderKey((k) => k + 1);
      }).catch(() => {
        setNlProcessing(null);
      });
    },
    [onParseNaturalLanguage, items, onChange],
  );

  const handleCommitFilter = useCallback(
    (filter: TableFilter) => {
      onChange([...items, filter]);
      setEditInitialFilter(undefined);
      setBuilderKey((k) => k + 1);
    },
    [items, onChange],
  );

  const [editInitialFilter, setEditInitialFilter] = useState<TableFilter | undefined>();

  const handleBuilderBackspace = useCallback(() => {
    if (items.length === 0) {
      setBuilding(false);
      return;
    }
    const lastIdx = items.length - 1;
    const lastItem = items[lastIdx];
    if (isFilterGroup(lastItem)) {
      onChange(items.slice(0, -1));
      return;
    }
    // Remove last filter and re-open builder fresh
    onChange(items.slice(0, -1));
    setEditInitialFilter(undefined);
    setBuilderKey((k) => k + 1);
  }, [items, onChange]);


  const handleRemoveTopLevel = useCallback(
    (index: number) => {
      onChange(items.filter((_, i) => i !== index));
    },
    [items, onChange],
  );

  const handleRemoveFromGroup = useCallback(
    (groupIndex: number, filterIndex: number) => {
      const next = [...items];
      const group = next[groupIndex] as FilterGroup;
      const updatedFilters = group.filters.filter((_, i) => i !== filterIndex);
      if (updatedFilters.length === 0) {
        onChange(next.filter((_, i) => i !== groupIndex));
      } else if (updatedFilters.length === 1) {
        next[groupIndex] = updatedFilters[0];
        onChange(next);
      } else {
        next[groupIndex] = { ...group, filters: updatedFilters };
        onChange(next);
      }
    },
    [items, onChange],
  );

  const handleUngroup = useCallback(
    (groupIndex: number) => {
      const group = items[groupIndex];
      if (!isFilterGroup(group)) return;
      const next = [...items];
      next.splice(groupIndex, 1, ...group.filters);
      onChange(next);
    },
    [items, onChange],
  );

  const handleToggleGroupConjunction = useCallback(
    (groupIndex: number) => {
      const next = [...items];
      const group = next[groupIndex] as FilterGroup;
      next[groupIndex] = {
        ...group,
        conjunction: group.conjunction === "and" ? "or" : "and",
      };
      onChange(next);
    },
    [items, onChange],
  );

  const handleGroupAdjacent = useCallback(
    (index: number) => {
      if (index === 0) return;
      const prev = items[index - 1];
      const curr = items[index];
      const next = [...items];
      if (isFilterGroup(prev) && !isFilterGroup(curr)) {
        next[index - 1] = { ...prev, filters: [...prev.filters, curr] };
        next.splice(index, 1);
      } else if (!isFilterGroup(prev) && !isFilterGroup(curr)) {
        const group: FilterGroup = {
          id: genId(),
          conjunction: conjunction === "and" ? "or" : "and",
          filters: [prev, curr],
        };
        next.splice(index - 1, 2, group);
      }
      onChange(next);
    },
    [items, conjunction, onChange],
  );

  function handleEditClick(filter: TableFilter, path: number[]) {
    // Remove the filter from its position and open the builder with it
    const removeAndEdit = (f: TableFilter, p: number[]) => {
      if (p.length === 1) {
        onChange(items.filter((_, i) => i !== p[0]));
      } else if (p.length === 2) {
        const next = [...items];
        const group = next[p[0]] as FilterGroup;
        const updatedFilters = group.filters.filter((_, i) => i !== p[1]);
        if (updatedFilters.length === 0) {
          next.splice(p[0], 1);
        } else if (updatedFilters.length === 1) {
          next[p[0]] = updatedFilters[0];
        } else {
          next[p[0]] = { ...group, filters: updatedFilters };
        }
        onChange(next);
      }
      setEditInitialFilter(f);
      setBuilding(true);
      setBuilderKey((k) => k + 1);
    };
    removeAndEdit(filter, path);
  }

  // Empty state
  if (items.length === 0 && !building && !nlProcessing) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setBuilding(true)}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <Filter size={12} />
          Filter & Search
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <Filter size={12} className="shrink-0 text-gray-400" />
      {items.map((item, i) => (
        <span
          key={isFilterGroup(item) ? item.id : item.id}
          className="inline-flex items-center gap-1.5"
        >
          {i > 0 && (
            <span className="inline-flex items-center gap-1">
              {i === 1 ? (
                <button
                  type="button"
                  onClick={() =>
                    onConjunctionChange(conjunction === "and" ? "or" : "and")
                  }
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase text-primary/70 transition-colors hover:bg-primary/10"
                >
                  {conjunction}
                </button>
              ) : (
                <span className="shrink-0 text-[11px] font-semibold uppercase text-gray-400">
                  {conjunction}
                </span>
              )}
              {!isFilterGroup(item) && !isFilterGroup(items[i - 1]) && (
                <button
                  type="button"
                  onClick={() => handleGroupAdjacent(i)}
                  title="Group with previous"
                  className="shrink-0 rounded p-0.5 text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-500"
                >
                  <Group size={11} />
                </button>
              )}
            </span>
          )}
          {isFilterGroup(item) ? (
            <GroupChips
              group={item}
              columns={columns}
              onEditFilter={(fi) => handleEditClick(item.filters[fi], [i, fi])}
              onRemoveFilter={(fi) => handleRemoveFromGroup(i, fi)}
              onToggleGroupConjunction={() => handleToggleGroupConjunction(i)}
              onUngroup={() => handleUngroup(i)}
            />
          ) : (
            <span data-filter-id={item.id}>
              <FilterChip
                filter={item}
                columns={columns}
                onEdit={() => handleEditClick(item, [i])}
                onRemove={() => handleRemoveTopLevel(i)}
              />
            </span>
          )}
        </span>
      ))}
      {nlProcessing && (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-[12px] text-gray-500">
          <Loader2 size={12} className="animate-spin text-primary/60" />
          <Sparkles size={11} className="text-primary/60" />
          <span className="italic">{nlProcessing}</span>
        </span>
      )}
      {!nlProcessing && (building ? (
        <PillBuilder
          key={builderKey}
          columns={columns}
          onCommit={handleCommitFilter}
          onCancel={() => { setBuilding(false); setEditInitialFilter(undefined); }}
          onBackspaceEmpty={handleBuilderBackspace}
          onNlSubmit={onParseNaturalLanguage ? handleNlFromBuilder : undefined}
          initialFilter={editInitialFilter}
        />
      ) : (
        <button
          type="button"
          onClick={() => setBuilding(true)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && items.length > 0) {
              e.preventDefault();
              handleBuilderBackspace();
              setBuilding(true);
            }
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <Plus size={11} />
          Add
        </button>
      ))}
      {items.length > 1 && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="shrink-0 text-[11px] text-gray-400 transition-colors hover:text-gray-600"
        >
          Clear all
        </button>
      )}
    </div>
  );
});
