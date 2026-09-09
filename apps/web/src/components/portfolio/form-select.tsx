"use client";

/**
 * Port of apps/app's Portfolio/Profile/AddInvestment/Select.tsx, which was
 * copy-pasted 8x across the ported form directories — consolidated to one
 * component here so those call sites need only swap their import. Prop
 * surface (value/setValue/load/options/onCreateOption/loading/isDisabled/
 * placeholder/autoFocus) is kept identical on purpose: the ported forms
 * reference these names directly.
 */

import { useMemo } from "react";
import type { GroupBase, StylesConfig } from "react-select";
import Select from "react-select";
import SelectAsync from "react-select/async";
import SelectCreatable from "react-select/creatable";
import SelectAsyncCreatable from "react-select/async-creatable";
import { ChevronDown } from "lucide-react";

export interface FormSelectOption<T> {
  label: string;
  value: T;
}

function DropdownIndicator() {
  return (
    <div className="flex items-center px-2 text-gray-400">
      <ChevronDown className="h-3.5 w-3.5" />
    </div>
  );
}

function selectStyles<T>(): StylesConfig<
  FormSelectOption<T>,
  false,
  GroupBase<FormSelectOption<T>>
> {
  return {
    control: (base, state) => ({
      ...base,
      minHeight: "37px",
      border: "1px solid",
      borderColor: state.isFocused ? "#8778F7" : "#E5E7EB",
      borderRadius: "6px",
      fontSize: "13px",
      boxShadow: state.isFocused ? "0 0 0 3px #8778F71A" : "none",
      "&:hover": { borderColor: state.isFocused ? "#8778F7" : "#D1D5DB" },
    }),
    input: (base) => ({ ...base, paddingBlock: 0, marginBlock: 0 }),
    placeholder: (base) => ({ ...base, color: "#9CA3AF" }),
    indicatorSeparator: (base) => ({ ...base, display: "none" }),
    dropdownIndicator: (base) => ({ ...base, padding: "4px 0" }),
    menu: (base) => ({ ...base, fontSize: "13px", zIndex: 9999 }),
    menuPortal: (base) => ({ ...base, zIndex: 9999 }),
    option: (base, state) => ({
      ...base,
      fontSize: "13px",
      backgroundColor: state.isSelected
        ? "#8778F7"
        : state.isFocused
          ? "#F5F3FE"
          : "white",
    }),
  };
}

export function FormSelect<T>({
  value,
  setValue,
  load,
  options,
  onCreateOption,
  loading,
  isDisabled,
  placeholder,
  autoFocus,
}: {
  value: FormSelectOption<T> | undefined;
  setValue: (value: FormSelectOption<T> | null) => unknown;
  load?: (inputValue: string) => Promise<FormSelectOption<T>[]>;
  options?: FormSelectOption<T>[];
  onCreateOption?: (inputValue: string) => T;
  loading?: boolean;
  isDisabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  // The variant is picked once (matches apps/app's original behavior) —
  // load/onCreateOption toggling after mount does not swap components.
  const Component = useMemo(() => {
    if (load) {
      return onCreateOption ? SelectAsyncCreatable : SelectAsync;
    }
    return onCreateOption ? SelectCreatable : Select;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Component<FormSelectOption<T>, false, GroupBase<FormSelectOption<T>>>
      autoFocus={autoFocus}
      placeholder={placeholder}
      isDisabled={isDisabled}
      isLoading={loading}
      value={value ?? null}
      cacheOptions
      defaultOptions
      menuPortalTarget={typeof document !== "undefined" ? document.body : undefined}
      menuPlacement="auto"
      styles={selectStyles<T>()}
      onChange={(next) => setValue(next)}
      loadOptions={load}
      components={{ DropdownIndicator }}
      options={options}
      // Matches apps/app's original wiring verbatim: react-select's own
      // onCreateOption type is `(inputValue: string) => void` and ignores
      // this return — selecting the created option is the caller's
      // responsibility inside their onCreateOption implementation.
      onCreateOption={(inputValue: string) => {
        onCreateOption?.(inputValue);
      }}
    />
  );
}
