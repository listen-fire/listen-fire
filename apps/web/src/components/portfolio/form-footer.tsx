/**
 * Standard Cancel/Submit row every ported form's Footer.tsx used —
 * apps/app's variants (AddInvestment, EditHeader, AddMarkdown, …) all
 * reduce to a right-aligned button pair: Cancel, and a Save/submit button
 * disabled while the form is invalid or mid-submit.
 */

import { buttonClass } from "@/components/ui";

export function FormFooter({
  onCancel,
  submitLabel = "Save",
  isSubmitting,
  isDisabled,
  error,
}: {
  onCancel: () => void;
  submitLabel?: string;
  isSubmitting?: boolean;
  isDisabled?: boolean;
  error?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-3">
      {error && (
        <div className="mr-auto text-[12px] text-red-600">{error}</div>
      )}
      <button
        type="button"
        onClick={onCancel}
        className={buttonClass({ variant: "ghost" })}
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={isDisabled || isSubmitting}
        className={buttonClass({ variant: "primary" })}
      >
        {isSubmitting ? "Saving…" : submitLabel}
      </button>
    </div>
  );
}
