import { formatRunCostUsd } from "../run-cost";

describe("formatRunCostUsd", () => {
  it("shows an em dash for a run with no model calls", () => {
    expect(formatRunCostUsd(0)).toBe("—");
  });

  it("shows an em dash for a negative value (defensive — should never occur)", () => {
    expect(formatRunCostUsd(-100)).toBe("—");
  });

  it("shows a placeholder for anything under a cent", () => {
    expect(formatRunCostUsd(1)).toBe("<$0.01");
    expect(formatRunCostUsd(9_999)).toBe("<$0.01");
  });

  it("shows dollars to the cent at and above a cent", () => {
    expect(formatRunCostUsd(10_000)).toBe("$0.01");
    expect(formatRunCostUsd(1_234_000)).toBe("$1.23");
    expect(formatRunCostUsd(1_235_500)).toBe("$1.24");
  });
});
