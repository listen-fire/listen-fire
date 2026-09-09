type InvestmentStatus = 'active' | 'realised';

// The single source of truth for "is there anything left to come?", answering
// the same question as InvestmentValuation.holdsRetainedAssets: do we still
// hold anything (non-cash, positive balance) that traces back to this
// investment — in the company itself or in whatever it turned into? An
// acquired position we're still sitting on is alive and still moving, so it
// reads active until the last of it is cash.
//
// This is what drives the portfolio CSV export's Status column, and anywhere
// else that wants exited-ness must derive it from the same input rather than
// re-deriving its own notion of "active".
function deriveInvestmentStatus(holdsRetainedAssets: boolean): InvestmentStatus {
  return holdsRetainedAssets ? 'active' : 'realised';
}

export { InvestmentStatus, deriveInvestmentStatus };
