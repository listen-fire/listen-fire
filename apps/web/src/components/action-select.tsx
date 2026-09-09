"use client";

import { useSelectDropdown, type SelectOption } from "./select";

interface ActionSelectProps {
  onSelect: (value: string) => void;
  options: SelectOption[];
  className?: string;
  title?: string;
}

export function ActionSelect({
  onSelect,
  options,
  className = "",
  title,
}: ActionSelectProps) {
  const {
    open,
    focusedIndex,
    containerRef,
    close,
    toggle,
    handleKeyDown,
    setFocusedIndex,
  } = useSelectDropdown({ options, onSelect });

  return (
    <div ref={containerRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        title={title}
        className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-[13px] text-gray-400 hover:bg-gray-200"
      >
        +
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-48 min-w-[180px] overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-gray-400">
              No options
            </div>
          ) : (
            options.map((option, i) => (
              <button
                key={option.value}
                type="button"
                ref={(el) => {
                  if (i === focusedIndex && el) {
                    el.scrollIntoView({ block: "nearest" });
                  }
                }}
                onMouseEnter={() => setFocusedIndex(i)}
                onClick={() => {
                  onSelect(option.value);
                  close();
                }}
                className={`flex w-full items-center px-3 py-1.5 text-left text-[12px] transition-colors ${
                  i === focusedIndex
                    ? "bg-gray-100 text-gray-900"
                    : "text-gray-700"
                }`}
              >
                {option.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
