// Adapter protocol 2.N: a module states the minor it uses, computed from what
// its manifest lists, and a host refuses one outside the range it speaks by
// name, in either direction. An unstated minor (every module published up to
// 0.12.5) is 2.0 and always passes.
import { PROTOCOL_MINOR, PROTOCOL_MINORS, WireManifestResult, protocolMinorOf, protocolStanding } from '../index';
import { WireSlotManifest } from '../slots';

const LF = { name: 'lf', version: '0.12.6' };
const SLACK = { name: 'slack', package: { name: '@listen-fire/slack', version: '0.13.1' }, host: LF };

describe('the minor a manifest uses', () => {
  it('is the highest minor among the features it lists', () => {
    expect(protocolMinorOf({ methods: ['manifest', 'describe'] })).toBe(0);
    expect(protocolMinorOf({ methods: ['manifest', 'movements.list', 'movements.watch'] })).toBe(1);
    expect(protocolMinorOf({ methods: ['manifest', 'store.watch', 'work.enqueueIfAbsent'] })).toBe(2);
  });

  it('ends at the minor this release speaks', () => {
    expect(PROTOCOL_MINOR).toBe(3);
    // 2.3 (labelled poll events) shows in no manifest: the author states it.
    expect(Math.max(...PROTOCOL_MINORS.map((entry) => entry.minor))).toBeLessThanOrEqual(PROTOCOL_MINOR);
  });

  it('is carried by an adapter manifest and a slot manifest', () => {
    const adapter = {
      protocolVersion: 2,
      protocolMinor: 0,
      adapterType: 'acme',
      supportedTriggers: [],
      runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
      methods: ['manifest'],
    };
    expect(WireManifestResult.parse(adapter).protocolMinor).toBe(0);
    expect(WireManifestResult.safeParse({ ...adapter, protocolMinor: -1 }).success).toBe(false);
    const slot = { protocolVersion: 2, protocolMinor: 1, name: 'acme', kind: 'core', slot: 'movements', methods: ['movements.watch'] };
    expect(WireSlotManifest.parse(slot).protocolMinor).toBe(1);
  });
});

describe('a host refuses a module outside the range it speaks, by name', () => {
  it('passes an unstated minor and every minor up to its own', () => {
    expect(protocolStanding({ protocolVersion: 2 }, SLACK)).toEqual({ ok: true });
    for (const minor of [0, 1, 2, 3]) expect(protocolStanding({ protocolVersion: 2, protocolMinor: minor }, SLACK)).toEqual({ ok: true });
  });

  it('refuses a newer minor, naming the package and the range', () => {
    expect(protocolStanding({ protocolVersion: 2, protocolMinor: 4 }, SLACK)).toEqual({
      ok: false,
      message:
        'external "slack" (@listen-fire/slack 0.13.1) speaks adapter protocol 2.4; this lf (0.12.6) speaks 2.0–2.3. ' +
        "Upgrade lf to a release that speaks 2.4 (the protocol's Changes list names it), or use a @listen-fire/slack that speaks 2.3 or lower.",
    });
    expect(protocolStanding({ protocolVersion: 2, protocolMinor: 4 }, { name: 'slack', host: LF })).toEqual({
      ok: false,
      message:
        'external "slack" speaks adapter protocol 2.4; this lf (0.12.6) speaks 2.0–2.3. ' +
        "Upgrade lf to a release that speaks 2.4 (the protocol's Changes list names it), or use a version of it that speaks 2.3 or lower.",
    });
  });

  it('refuses a newer major', () => {
    expect(protocolStanding({ protocolVersion: 3 }, { name: 'slack', host: LF })).toEqual({
      ok: false,
      message: 'external "slack": speaks adapter protocol 3; this lf (0.12.6) speaks 2.0–2.3. Upgrade lf.',
    });
  });

  it('refuses an older major in the words it always has', () => {
    expect(protocolStanding({ protocolVersion: 1 }, { name: 'slack', host: LF })).toEqual({
      ok: false,
      message: 'external "slack": protocolVersion: expected 2, got 1 — this adapter targets an older adapter protocol; update it to protocol version 2.',
    });
    expect(protocolStanding({}, { name: 'slack', host: LF })).toMatchObject({ message: expect.stringContaining('got nothing') });
  });

  it('refuses a minor that is not a whole number', () => {
    expect(protocolStanding({ protocolVersion: 2, protocolMinor: 1.5 }, { name: 'slack', host: LF })).toEqual({
      ok: false,
      message: 'external "slack": protocolMinor: expected a whole number, got 1.5.',
    });
  });

  it("names a slot module's slot", () => {
    const acme = { name: 'acme_store', slot: 'store', host: LF };
    expect(protocolStanding({ protocolVersion: 2, protocolMinor: 9 }, acme)).toMatchObject({
      message: expect.stringMatching(/^core module "acme_store" \(store slot\) speaks adapter protocol 2\.9; this lf \(0\.12\.6\) speaks 2\.0–2\.3\./),
    });
    expect(protocolStanding({ protocolVersion: 3 }, acme)).toMatchObject({
      message: 'core module "acme_store" (store slot): speaks adapter protocol 3; this lf (0.12.6) speaks 2.0–2.3. Upgrade lf.',
    });
    expect(protocolStanding({ protocolVersion: 1 }, acme)).toMatchObject({
      message: 'core module "acme_store" (store slot): protocolVersion: expected 2, got 1 — this module targets an older adapter protocol; update it to protocol version 2.',
    });
  });

  it('words a refusal without a name for a caller that names the module itself', () => {
    const engine = { host: { name: '@listen-fire/engine', version: '0.12.6' } };
    expect(protocolStanding({ protocolVersion: 3 }, engine)).toMatchObject({
      message: 'it speaks adapter protocol 3; this @listen-fire/engine (0.12.6) speaks 2.0–2.3. Upgrade @listen-fire/engine.',
    });
    expect(protocolStanding({ protocolVersion: 1 }, engine)).toMatchObject({
      message: 'protocolVersion: expected 2, got 1 — this adapter targets an older adapter protocol; update it to protocol version 2.',
    });
  });
});
