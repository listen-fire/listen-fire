"use client";

import { useSelectDropdown, SelectDropdown, type SelectOption } from "./select";

interface InlineSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  autoOpen?: boolean;
  className?: string;
  align?: "left" | "right";
  textSize?: string;
}

export function InlineSelect({
  value,
  onChange,
  options,
  placeholder = "—",
  disabled = false,
  autoOpen = false,
  className = "",
  align = "right",
  textSize = "text-[13px]",
}: InlineSelectProps) {
  const {
    open,
    focusedIndex,
    containerRef,
    listRef,
    close,
    toggle,
    handleKeyDown,
    setFocusedIndex,
  } = useSelectDropdown({ options, value, disabled, onSelect: onChange });

  const selectedOption = options.find((o) => o.value === value);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        autoFocus
        onFocus={() => { if (autoOpen && !open) toggle(); }}
        className={`-mb-px border-0 border-b border-b-primary/40 bg-transparent p-0 ${textSize} outline-none disabled:opacity-50 ${
          align === "right" ? "text-right" : "text-left"
        } ${selectedOption ? "text-gray-800" : "text-gray-400"}`}
      >
        {selectedOption ? selectedOption.label : placeholder}
      </button>

      {open && (
        <SelectDropdown
          options={options}
          value={value}
          focusedIndex={focusedIndex}
          listRef={listRef}
          anchorRef={containerRef}
          size="sm"
          onSelect={(v) => {
            onChange(v);
            close();
          }}
          onHover={setFocusedIndex}
        />
      )}
    </div>
  );
}
