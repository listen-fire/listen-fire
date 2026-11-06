// The `Actor` field a host offers on what lands, from a module's
// `ActorIdentity`. Held to docs/contracts/actor-field.md by a test that reads
// its table, and by the Rust twin in `lf`. The language names none of this.
import type { ActorIdentity } from './adapter';

export const ACTOR_FIELDS = ['Id', 'Email', 'Domain', 'Phone', 'Name', 'Proven'] as const;

export interface NormalisedActor {
  Id: string;
  Email?: string;
  Domain?: string;
  Phone?: string;
  Name?: string;
  Proven: boolean;
}

/** `null` when the identity names nobody: a field that may be absent is better than an empty one a filter could match. */
export function normalisedActor(identity: ActorIdentity): NormalisedActor | null {
  if (identity.identifier.trim() === '') return null;
  const actor: NormalisedActor = { Id: identity.identifier, Proven: identity.proven === true };

  // The address is `email`, else the identifier of an `email` identity ([Who acted]).
  const address = (identity.email ?? (identity.scheme === 'email' ? identity.identifier : undefined))?.trim().toLowerCase();
  if (address !== undefined && address !== '') {
    actor.Email = address;
    // The last `@`, so `a@x.com.evil.com` can never read as `x.com`.
    const at = address.lastIndexOf('@');
    if (at !== -1 && at < address.length - 1) actor.Domain = address.slice(at + 1);
  }

  if (identity.scheme === 'phone') {
    const digits = identity.identifier.replace(/\D/g, '');
    if (digits !== '') actor.Phone = digits;
  }

  const name = identity.name ?? identity.label;
  if (name !== undefined && name !== '') actor.Name = name;

  return actor;
}
