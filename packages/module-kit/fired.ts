// What a run was fired on, as a module's actor methods (`extractActor`,
// `getActorCandidates`) read it. Every run a listen fires is handed the
// arrival that fired it, the record that landed on the listen's last edge
// (adapter protocol 2.6), and who acted, as the module said at the door
// (2.7); no 0.13 run is handed a `payload`.

import type { ActorIdentity, TriggerEvent } from 'engine-contracts';

/** The fields of the record a run was fired on, as its module put them on
 *  the arrival's landing (its raw fields beside the named ones); none when
 *  the run was not fired by an arrival. */
export function firedRecordFields(event: TriggerEvent): Record<string, unknown> {
  return event.arrival?.landing.fields ?? {};
}

/** Who acted on the arrival a run was fired on, as its module said at the
 *  door (`actor`, adapter protocol 2.7); null when it named no one. */
export function firedActor(event: TriggerEvent): ActorIdentity | null {
  return event.arrival?.actor ?? null;
}
