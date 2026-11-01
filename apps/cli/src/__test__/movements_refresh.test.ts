// A long-running `listen-fire serve` takes a changed movement without a restart: the
// folder's watcher (the OS's own) tells it what changed, at the default
// settings, and it swaps the files it runs.
// A listen keeps its name across the swap, so the cursor of the poll it
// shares and the receipts of the arrivals it ran carry over; a new file's
// listen starts, the external it imports started with it.

import assert from 'node:assert/strict';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { lf, served } from './example';
import { edgePolls, feed, feedProject } from './feed';

function runsOfSeen(dir: string): string[] {
  return lf(dir, 'runs').out.split('\n').filter((l) => l.includes('notes:seen'));
}

test("a changed movement's next poll runs its new text, from the cursor it had", async () => {
  const dir = feedProject();
  writeFileSync(join(dir, 'externals/feed/fast'), '');
  const server = await served(dir);
  try {
    // The first poll only arms: the notes already there fire nothing.
    await server.waitFor(/armed; it fires on changes from now/);
    feed(dir, [
      { id: 'n1', title: 'First', at: 1 },
      { id: 'n2', title: 'Second', at: 2 },
      { id: 'n3', title: 'Third', at: 3 },
    ]);
    await server.waitFor(/MOVENG_ERROR: seen Third/);
    const notes = join(dir, 'movements/notes.mvt');
    const seen = readFileSync(notes, 'utf8');
    const now = seen.replace('fail("seen ${n.Title}")', 'fail("now ${n.Title}")');
    assert.notEqual(now, seen, "feed.ts's movement changed; update this test");
    writeFileSync(notes, now);
    await server.waitFor(/^movements: notes\.mvt changed$/);
    feed(dir, [
      { id: 'n3', title: 'Third', at: 3 },
      { id: 'n4', title: 'Fourth', at: 4 },
    ]);
    await server.waitFor(/MOVENG_ERROR: now Fourth/);
  } finally {
    await server.stop();
  }
  assert.ok(
    edgePolls(dir).some((poll) => JSON.stringify(poll) === JSON.stringify({ edge: 'Notes', cursor: 3 })),
    'a poll after the swap starts from the cursor before it',
  );
  assert.equal(runsOfSeen(dir).length, 2, 'Third ran once, before the swap, and Fourth once after it');
});

test("a new file's listen fires, the external it imports started", async () => {
  const dir = feedProject();
  writeFileSync(join(dir, 'externals/feed/fast'), '');
  const notes = join(dir, 'movements/notes.mvt');
  const aside = join(dir, 'notes.mvt.aside');
  renameSync(notes, aside);
  const server = await served(dir);
  try {
    renameSync(aside, notes);
    await server.waitFor(/^movements: notes\.mvt added$/);
    await server.waitFor(/^movements: started feed$/);
    await server.waitFor(/armed; it fires on changes from now/);
    feed(dir, [{ id: 'n3', title: 'Third', at: 3 }]);
    await server.waitFor(/MOVENG_ERROR: seen Third/);
  } finally {
    await server.stop();
  }
});
