"use client";

/**
 * apps/app used a Chakra date picker; apps/web has no date-picker
 * component, so a native <input type="date"> is correct here — it needs
 * no extra dependency and every browser gives it a real picker UI. Value
 * is an ISO `yyyy-MM-dd` string (or undefined), matching what
 * `<input type="date">` natively reads/writes.
 */

export function DateInput({
  value,
  onChange,
  disabled,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="date"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
      disabled={disabled}
      className="w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
    />
  );
}
