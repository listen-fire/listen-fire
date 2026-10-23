// The movements slot's methods (docs/contracts/movements-slot.md): where the
// project's movement files live. A module lists every file by its path under
// the movements folder, reads one, and writes one by compare-and-swap on its
// version. `lf.yaml` and the externals folder stay local files.

import { z } from 'zod';

import { WatchRequest, watchAnswer } from './wire';

export const MOVEMENTS_METHODS = ['movements.list', 'movements.read', 'movements.write', 'movements.watch'] as const;

/** A file's path under the movements folder: `/`-separated, ending `.mvt`,
 *  no segment empty, `.` or `..`, and no `\` (`orders/sync.mvt`). */
export const MovementPath = z.string().refine(isMovementPath, 'a movement path: relative to the movements folder, `/`-separated, ending .mvt');

export function isMovementPath(path: string): boolean {
  const segments = path.split('/');
  return (
    !path.includes('\\') &&
    path.endsWith('.mvt') &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    segments.at(-1) !== '.mvt'
  );
}

/** Opaque; it changes whenever the text changes. */
const Version = z.string().min(1);

/** One file `movements.list` names; without a version, `lf` reads it on every scan. */
export const MovementsListed = z.object({ path: MovementPath, version: Version.optional() });

export const MovementsListAnswer = z.array(MovementsListed);

/** What `movements.read` answers (or null: nothing is at the path). */
export const MovementsReadAnswer = z.object({ text: z.string(), version: Version }).nullable();

export const MovementsReadRequest = z.object({ path: MovementPath });

/** `expectedVersion` is present: a version replaces the file only if it is
 *  still at it; null creates it only if nothing is at the path. */
export const MovementsWriteRequest = z.object({ path: MovementPath, text: z.string(), expectedVersion: Version.nullable() });

export const MovementsWriteAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('written'), version: Version }),
  /** `current`: the version there now, or null when there is none. */
  z.object({ kind: z.literal('conflict'), current: Version.nullable() }),
  /** The module keeps the project's movements where `lf` cannot change them. */
  z.object({ kind: z.literal('read_only'), reason: z.string().min(1) }),
]);
export type MovementsWriteAnswerShape = z.infer<typeof MovementsWriteAnswer>;

/** One change `movements.watch` reports. `version` is the one `read` answers; a module that can change its files gives it on `added` and `changed`. */
export const MovementsChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('added'), path: MovementPath, version: Version.optional() }),
  z.object({ kind: z.literal('changed'), path: MovementPath, version: Version.optional() }),
  z.object({ kind: z.literal('removed'), path: MovementPath }),
]);
export type MovementsChangeShape = z.infer<typeof MovementsChange>;

export const MovementsWatchRequest = WatchRequest;

export const MovementsWatchAnswer = watchAnswer(MovementsChange);
export type MovementsWatchAnswerShape = z.infer<typeof MovementsWatchAnswer>;
