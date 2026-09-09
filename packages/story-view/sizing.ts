/**
 * How big things are on the board — the whole sizing model, in two numbers.
 *
 * Nothing has a MINIMUM. A column is as wide as what is in it, a lane as wide
 * as the widest lane beside it, a card as wide as its own words; a story of one
 * trigger and one call takes the room of a trigger and a call. What used to
 * hold the board apart was a column minimum wide enough for the widest story
 * anyone might write, which padded every narrow one out to the same size and
 * left the picture floating in its own margins.
 *
 * `NODE_MAX` is a CAP, never a width. It is what keeps a column narrow: a
 * column is as wide as the widest thing in it, so a sentence with no cap would
 * set the width of the whole story to its own unwrapped length. Capped, it
 * wraps instead — which is the rule the canvas already lives by (nothing
 * truncates), now load-bearing for layout as well as for honesty.
 *
 * `COLUMN_GAP` is the other half: with no minimums, the space between two
 * stories has to be real space rather than the slack inside two fixed columns.
 *
 */

/** Every node the canvas draws — card, bar, frame head, lane label — stops
 *  growing here and wraps. */
export const NODE_MAX = "max-w-[34rem]";

/** The room between two stories on the board: the only thing separating them,
 *  now that neither is padded out to a width it doesn't need. */
export const COLUMN_GAP = "gap-16";
