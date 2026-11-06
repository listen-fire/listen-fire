// `listen-fire catalog <address>`: one connection or one place, spelled as a
// program spells them and read by the parser and the checker. The fake module
// (address_module) has each kind of edge a walk goes through; `@lf/forms` has
// the kind known only by what is written to it for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { lf, project } from './example';
import { lf as lfAsync, ok } from './interactive';

const LEGEND = 'plain edges read; [r w fires] read, write, listen; ! required, * identifying, ~ read only';

function places(): string {
  const dir = project();
  const folder = join(dir, 'externals/places');
  mkdirSync(folder);
  copyFileSync(resolve(__dirname, 'address_module/serve.mjs'), join(folder, 'serve.mjs'));
  writeFileSync(join(folder, 'lf-external.yaml'), 'name: places\nkind: adapter\ncommand: [node, serve.mjs]\n');
  return dir;
}

/** The description printed at an address, whole. */
function described(dir: string, address: string): string {
  const shown = lf(dir, 'catalog', address);
  assert.equal(shown.code, 0, `${address}: ${shown.out}`);
  return shown.out.trimEnd();
}

/** What refused an address: it exits 1 and prints no description. */
function refused(dir: string, address: string): string {
  const shown = lf(dir, 'catalog', address);
  assert.equal(shown.code, 1, `${address}: ${shown.out}`);
  assert.doesNotMatch(shown.out, /^place:|^fields/m, 'a diagnostic prints no description');
  return shown.out.trimEnd();
}

test('one connection is the block the whole project text prints for it', () => {
  const dir = places();
  const block = described(dir, '#places');
  assert.ok(block.startsWith(`${LEGEND}\n\nconnection places (no credential): #places\nuse: c = connect #places\n`), block);
  assert.doesNotMatch(block, /acme|always connected/, 'that connection alone');
  const whole = lf(dir, 'catalog');
  assert.equal(whole.code, 0, whole.out);
  assert.ok(whole.out.includes(block.slice(`${LEGEND}\n\n`.length)), whole.out);

  // With a credential, as a program's connect has one.
  assert.match(described(dir, '#acme_crm:acme'), /^connection acme: #acme_crm\nuse: c = connect #acme_crm using acme$/m);
});

test('the whole project text says the marks once, and how to address one place in single quotes', () => {
  const whole = lf(places(), 'catalog');
  assert.equal(whole.code, 0, whole.out);
  const lines = whole.out.split('\n');
  assert.equal(lines[0], LEGEND);
  assert.equal(lines.filter((line) => line === LEGEND).length, 1);
  assert.equal(lines.filter((line) => line.includes("listen-fire catalog '<module>:<credential>-[:<edge>]->'")).length, 1);
});

test('one place is its description, its fields, and each edge leaving it with the fields where that lands', () => {
  assert.equal(
    described(places(), '#places-[:Channels]->'),
    [
      LEGEND,
      "place: '#places-[:Channels]->'",
      'Channel',
      'A place people talk.',
      'fields:',
      '  Name text: What it is called.',
      '  `Secret Name` text',
      'edges:',
      '  -[:Posts]-> Post [w]: Text!, `Reply Markup`',
      '    Post into it.',
      '    A post in a channel.',
      '    Text! text: What it says.',
      '    Id~ text',
      '    `Reply Markup` json (write only)',
      '  -[:`Linked Users`]-> Linked User',
      '    Email text',
      '  -[:Pings]-> Press [fires]',
      '    One button pressed.',
      '    Label text: The button.',
      '  -[:Archives]-> Archived',
      '    Kept text',
    ].join('\n'),
  );
});

test('a further hop needs nothing of its own, backticks included', () => {
  const dir = places();
  assert.match(described(dir, '#places-[:Channels]->-[:`Linked Users`]->'), /^Linked User\nfields:\n {2}Email text\nedges: none$/m);
  assert.match(described(dir, '#places-[:Channels]->-[:Archives]->-[:Owner]->'), /^Linked User\n/m);
});

// plans/graph-description-2026-11-06/DESIGN.md, "What a walk does at a write
// only edge": a program's walk stops differently at each, a description's goes
// on through all three.
test('a walk goes through a write only edge off a record', () => {
  const dir = places();
  assert.match(described(dir, '#places-[:Channels]->-[:Posts]->'), /^Post\nA post in a channel\.\nfields:\n {2}Text! text: What it says\.$/m);
  assert.match(described(dir, '#places-[:Channels]->-[:Posts]->-[:Reactions]->'), /^Press\n/m);
  assert.match(refused(dir, '#places-[:Channels]->-[:Posts]->-[:Nope]->'), /^error MOV_TRAVERSE_UNKNOWN_EDGE .*'Nope' — it has: Reactions$/m);
});

test('a walk goes through a write only edge off the connection, to a type with readable fields', () => {
  const dir = places();
  assert.match(described(dir, '#places-[:Archive]->'), /^Archived\nfields:\n {2}Kept text\nedges:\n {2}-\[:Owner\]-> Linked User$/m);
  assert.match(refused(dir, '#places-[:Archive]->-[:Nope]->'), /^error MOV_TRAVERSE_UNKNOWN_EDGE .*'Nope' — it has: Owner$/m);
});

test('a walk goes through a write only edge off the connection, to a type known only by what is written to it', () => {
  const dir = places();
  assert.match(described(dir, '#places-[:approve]->'), /^edges:\n {2}-\[:Presses\]-> Press \[fires\]$/m);
  assert.match(described(dir, '#places-[:approve]->-[:Presses]->'), /^Press\nOne button pressed\.\nfields:\n {2}Label text: The button\.\nedges: none$/m);
  assert.match(refused(dir, '#places-[:approve]->-[:Nope]->'), /^error MOV_TRAVERSE_UNKNOWN_EDGE .*'Nope' — it has: Presses$/m);
  // A type with no edges at all reports the hop too.
  assert.match(refused(dir, '#places-[:notify]->-[:Nope]->'), /^error MOV_TRAVERSE_UNKNOWN_EDGE .*'Nope'$/m);
});

test('a type known only by what is written to it shows its description and its fields descriptions', () => {
  assert.equal(
    described(places(), '#places-[:approve]->'),
    [
      LEGEND,
      "place: '#places-[:approve]->'",
      'Approval',
      'Ask a person to approve: the template reads "Hello {{Customer}}, approve {{Amount}}?".',
      'fields:',
      '  Amount! "low" | "high": How much is asked.',
      "  Customer text: Who it is for: the template's first placeholder.",
      'edges:',
      '  -[:Presses]-> Press [fires]',
      '    Each button pressed.',
      '    One button pressed.',
      '    Label text: The button.',
    ].join('\n'),
  );
});

test('a real module\'s form is described through the edge a program only writes', async () => {
  const dir = project();
  await ok(lfAsync(dir, ['connect', '@lf/forms', '--yes']));
  const form = described(dir, '@lf/forms-[:Forms]->');
  assert.match(form, /^Form\nA form at a link, answered once\.$/m);
  assert.match(form, /^ {2}Title! text: What the form asks, shown above its fields\.$/m);
  assert.match(form, /^ {2}-\[:Submissions\]-> Submission \[fires\]$/m);
  assert.match(described(dir, '@lf/forms-[:Forms]->-[:Submissions]->'), /^Submission\n/m);
  assert.match(refused(dir, '@lf/forms-[:Forms]->-[:Nope]->'), /'Nope' — it has: Submissions$/m);
});

test('a misspelt edge lists the edges there are', () => {
  assert.match(refused(places(), '#places-[:Chanels]->'), /^error MOV_TRAVERSE_UNKNOWN_EDGE 'c' has no collection 'Chanels' — it has: Channels, Post, Archive, approve, notify$/m);
  assert.match(refused(places(), '#places-[:Channels]->-[:Psts]->'), /^error MOV_TRAVERSE_UNKNOWN_EDGE .*'Psts' — it has: Posts, Linked Users, Pings, Archives$/m);
});

test('a WHERE is refused as in a program, a field that does not exist and a name nothing binds', () => {
  const dir = places();
  assert.match(described(dir, '#places-[c:Channels WHERE c.Name == "a"]->'), /^Channel\n/m);
  assert.match(refused(dir, '#places-[c:Channels WHERE c.Nope == "a"]->'), /^error MOV\w+ .*Nope/m);
  assert.match(refused(dir, '#places-[c:Channels WHERE c.Name == other]->'), /^error MOV_NAME_UNRESOLVED .*'other'/m);
});

test('a walk that does not parse says so', () => {
  assert.match(refused(places(), '#places-[:Channels'), /^error MOV_PARSE the walk c-\[:Channels: /m);
  assert.match(refused(places(), '#places nonsense'), /^error MOV_PARSE the connection, written as a program's connect \(c = connect #places nonsense\): /m);
});

test('an unknown connection or credential is refused with what there is', () => {
  const dir = places();
  const unknown = refused(dir, '#nope-[:Channels]->');
  assert.match(unknown, /^error MOV_NAME_UNRESOLVED '#nope' is no adapter here \(the adapters: .*#places/m);
  assert.match(unknown, /#acme_crm/, 'every installed module is named, not only those the address connects');
  assert.match(refused(dir, '@lf/nope'), /^error MOV_NAME_UNRESOLVED .*@lf\/nope/m);
  assert.match(refused(dir, '#acme_crm:nope-[:Company]->'), /^error MISSING_CREDENTIAL credential "nope" is named here but not configured/m);
  assert.match(refused(dir, '#acme_crm-[:Company]->'), /^error MOV_CONSTRUCT_MISSING_CRED /m);
});

test('an address reads one connection, whatever the project\'s files name', () => {
  const dir = places();
  writeFileSync(join(dir, 'movements/broken.mvt'), 'c = connect #nope using gone\nnot a program\n');
  assert.match(described(dir, '#places-[:Channels]->'), /^Channel\n/m);
});

test('an address ends on a hop: a field read past it is no place', () => {
  assert.match(refused(places(), '#places-[:Channels]->.Name'), /goes on past its last hop/);
});

test('--json with an address is refused: it is not designed yet', () => {
  const shown = lf(places(), 'catalog', '#places', '--json');
  assert.equal(shown.code, 1, shown.out);
  assert.deepEqual(Object.keys(JSON.parse(shown.out) as object), ['error']);
  assert.match(shown.out, /not designed/);
});

test('more than one address is the usage', () => {
  const shown = lf(places(), 'catalog', '#places', '#acme_crm');
  assert.equal(shown.code, 2, shown.out);
  assert.match(shown.out, /usage: listen-fire catalog/);
});
