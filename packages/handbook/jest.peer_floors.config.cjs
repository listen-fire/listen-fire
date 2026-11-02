// Not part of the handbook's unit tests (they run offline and fast): the
// peer-floor check installs older core releases from npm. It is run by
// `node scripts/release/check-peer-floors.mjs`.
const base = require('../../jest.config.base.cjs');

module.exports = base(__dirname, {
  testMatch: ['**/__test__/peer_floors.check.ts'],
});
