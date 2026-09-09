/**
 * Ported from apps/app's FundingSection/common.tsx. Copied near-identically
 * into company/add-distribution, company/edit-transaction, company/edit-round,
 * company/add-markdown, company/convert-convertible, and company/funding
 * when those subtrees were ported in parallel by different agents;
 * consolidated here as the single canonical definition.
 */

export function FutureDateWarning({ value }: { value: string }) {
  if (!value) return null;
  const today = new Date().toISOString().split("T")[0];
  if (value <= today) return null;
  return (
    <span className="text-[12px] text-orange-500">
      This date is in the future
    </span>
  );
}
