/**
 * Amount fields on this form are *strings* end-to-end — the addInvestment
 * input takes `z.string()` for every money/share amount — so the display
 * formatting is done by hand here rather than through react-number-format.
 */

export function toMaxFixed(value: number, max: number) {
  return (+value.toFixed(max)).toString();
}
