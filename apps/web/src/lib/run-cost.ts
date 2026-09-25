// A run's model-call cost arrives from the server in microdollars (whole
// dollars * 1e6 — the same unit `llm_usage.cost_microdollars` stores), so
// summing many runs never loses precision to float cents. Formatting to the
// cent happens once, here, at the display edge.
export function formatRunCostUsd(costMicrodollars: number): string {
  if (costMicrodollars <= 0) return "—";
  const dollars = costMicrodollars / 1_000_000;
  if (dollars < 0.01) return "<$0.01";
  return `$${dollars.toFixed(2)}`;
}
