// The Rust checker's stamps as the TypeScript reads them: each a path and
// exactly one fact, as the engine's `join_check` holds them
// (crates/movement-engine/src/program.rs).

import { stampOf } from '../rust_checker';

describe('a stamp from the Rust checker', () => {
  it('reads each fact', () => {
    expect(stampOf({ path: '/statements/2/body/0', opensWaits: ['Interactions'] })).toEqual({ path: '/statements/2/body/0', opensWaits: ['Interactions'] });
    expect(stampOf({ file: 'lib/waits', path: '/statements/2/body/1/value/await/source', listsFirst: true })).toEqual({
      file: 'lib/waits',
      path: '/statements/2/body/1/value/await/source',
      listsFirst: true,
    });
    expect(stampOf({ path: '/statements/2/body/0/write/target', writtenType: 'Companies' })).toEqual({ path: '/statements/2/body/0/write/target', writtenType: 'Companies' });
    expect(stampOf({ path: '/statements/3/params/0', carriedAwaits: { Deal: ['Changes', 'Notes'] } })).toEqual({ path: '/statements/3/params/0', carriedAwaits: { Deal: ['Changes', 'Notes'] } });
    expect(() => stampOf({ path: '/statements/3/params/0', carriedAwaits: { Deal: 'Changes' } })).toThrow('the Rust checker answered a stamp that stamps nothing');
    const nodeSchema = { fields: { Approve: 'boolean' } };
    expect(stampOf({ path: '/statements/3/body/0/value/write/fields/1/value', nodeSchema })).toEqual({ path: '/statements/3/body/0/value/write/fields/1/value', nodeSchema });
  });

  it('refuses a stamp of more than one fact, naming them', () => {
    expect(() => stampOf({ path: '/statements/2/body/0', opensWaits: ['Interactions'], listsFirst: true })).toThrow(
      'the Rust checker answered a stamp of more than one fact (opensWaits, listsFirst)',
    );
  });

  it('refuses a stamp of no fact', () => {
    expect(() => stampOf({ path: '/statements/2/body/0' })).toThrow('the Rust checker answered a stamp that stamps nothing');
  });
});
