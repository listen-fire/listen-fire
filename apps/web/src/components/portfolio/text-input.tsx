/**
 * Raw <input>/<textarea> wrappers carrying the dense app-surface class
 * string used across the ported forms' text fields.
 */

const BASE_CLASS =
  "w-full rounded-md border px-3 py-2 text-[13px] focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400";

function borderClass(invalid?: boolean) {
  return invalid
    ? "border-red-300 focus:border-red-400"
    : "border-gray-200 focus:border-gray-400";
}

export function TextInput({
  invalid,
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      className={`${BASE_CLASS} ${borderClass(invalid)} ${className}`}
    />
  );
}

export function TextArea({
  invalid,
  className = "",
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...props}
      className={`${BASE_CLASS} ${borderClass(invalid)} ${className}`}
    />
  );
}
