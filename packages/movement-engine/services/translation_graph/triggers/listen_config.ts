// Which connection's deliveries a listen hears.

/**
 * Whether a delivery for `delivered` reaches a listen whose construction names
 * `listened` (the credential each names, by its imported name): the
 * platform's per-trigger credential narrowing, which listen-fire keeps too
 * (crates/lf/src/routing.rs, `Listen::hears`). A listen that names a
 * credential hears only that credential's deliveries; a listen that names
 * none hears every delivery, and a delivery that names none (addressed to the
 * module's install, which serves every connection) reaches every listen.
 */
export function listenHearsCredential(listened: string | undefined, delivered: string | undefined): boolean {
  return listened === undefined || delivered === undefined || listened === delivered;
}
