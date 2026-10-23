// Writes the handbook corpus the language service is held to: catalog.json,
// the snapshot every handbook example is checked against (HANDBOOK_CATALOG),
// and programs.json, each core chapter's probes with the library files they
// import, the probes the check exempts left out. handbook_parity.rs asks the
// native service at positions chosen from each probe's text and compares the
// answers with answers.json; the wasm's binding is held to the same file.
// Stable: a rerun writes the same bytes while the chapters are unchanged.
//
// Regenerate from the repository root, then re-bless answers.json
// (LF_BLESS=1 cargo test -p listen-fire-language --test handbook_parity):
//   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node","resolveJsonModule":true}' \
//     node_modules/.bin/ts-node --transpile-only crates/movement-language/tests/handbook/generate.ts

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { CORE_CHAPTERS } from '../../../../packages/handbook/index';
import { HANDBOOK_CATALOG, checkExemption, claimsOf } from '../../../../packages/handbook/testing';

const programs = claimsOf(Object.values(CORE_CHAPTERS))
  .filter((claim) => checkExemption(claim) === undefined)
  .map((claim) => ({
    chapter: claim.chapter,
    construct: claim.construct,
    source: claim.probe,
    ...(claim.status === 'runs' && claim.files ? { files: claim.files } : {}),
  }));

writeFileSync(path.join(__dirname, 'catalog.json'), `${JSON.stringify(HANDBOOK_CATALOG, null, 2)}\n`);
writeFileSync(path.join(__dirname, 'programs.json'), `${JSON.stringify(programs, null, 2)}\n`);
console.log(`programs.json: ${programs.length} programs from ${Object.keys(CORE_CHAPTERS).length} chapters`);
