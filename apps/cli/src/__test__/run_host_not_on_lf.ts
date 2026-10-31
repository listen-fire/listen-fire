// The run host contract cases (movement-engine's run_host/contract.ts) that
// listen-fire's stores no longer serve: since 0.13 an `await` waits on a
// listenable edge (store-slot `waits.*`), so the stores keep no await
// correlations and no callbacks. These cases drive the TypeScript run host's
// own drain, which still keys its awaits by correlation until it moves to
// waits; they are skipped against listen-fire, not dropped, so the gap shows.
export const RUN_HOST_CASES_NOT_ON_LF = new Set([
  'correlation: one entry per park, team-scoped, dropped per park or per run',
  'race: losing subtrees go by parsed address, sparing the winner, with their joins, correlations and keeper records',
  'drain: branches completing in one batch defer their race, which settles once with every winner',
  'drain: an await re-armed at its own address keeps its row and correlation; a slept timer steps past its sleep',
  'drain: an engine failure tears the run down, closing its keeper records and correlations',
  'drain: a run an operator asked to cancel is settled failed with their reason, and nothing is stepped',
  'drain: a lease lost mid-batch stops before the next leaf, leaving every row',
  'wake: a signal drives every run parked on its key, each under its lease; a run held elsewhere is busy',
  "park sink: an await parks its leaf, then its correlation, and arms nothing; a timer arms its run's wake",
  "park sink: a cancel stamped while the run parked settles it at once; a lapsed holder's park is refused",
  'cancel: a parked run with a cancel request settles failed with its reason; its leaves, correlations and callbacks close',
]);
