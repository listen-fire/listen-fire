// A long-running `listen-fire serve` takes a changed movement without a restart: the
// folder's watcher (the OS's own) tells it what changed, at the default
// settings, and it swaps the files it runs.
// A listen keeps its name across the swap, so its checkpoint and the
// receipts of the events it ran carry over; a new file's listen starts, the
// external it imports started with it.

import assert from 'node:assert/strict';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { lf, served } from './example';
import { feed, feedProject, polls } from './feed';

function runsOfSeen(dir: string): string[] {
  return lf(dir, 'runs').out.split('\n').filter((l) => l.includes('notes:seen'));
}

test("a changed movement's next poll runs its new text, from the checkpoint it had", async () => {
  const dir = feedProject();
  writeFileSync(join(dir, 'externals/feed/fast'), '');
  const server = await served(dir);
  try {
    await server.waitFor(/MOVENG_ERROR: seen Second/);
    const notes = join(dir, 'movements/notes.mvt');
    const seen = readFileSync(notes, 'utf8');
    const now = seen.replace('fail("seen ${n.Title}")', 'fail("now ${n.Title}")');
    assert.notEqual(now, seen, "feed.ts's movement changed; update this test");
    writeFileSync(notes, now);
    await server.waitFor(/^movements: notes\.mvt changed$/);
    feed(dir, [
      { id: 'n2', title: 'Second', at: 2 },
      { id: 'n3', title: 'Third', at: 3 },
    ]);
    await server.waitFor(/MOVENG_ERROR: now Third/);
  } finally {
    await server.stop();
  }
  assert.equal(polls(dir)[1], 2, 'the poll after the swap starts from the checkpoint before it');
  assert.equal(runsOfSeen(dir).length, 3, 'First and Second ran once each, before the swap');
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
    await server.waitFor(/MOVENG_ERROR: seen First/);
  } finally {
    await server.stop();
  }
});
