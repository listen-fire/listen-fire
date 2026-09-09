/**
 * Build the standalone story bundles, emitted where the API serves static
 * files from (`apps/api/public/story/`). TWO shapes of the same renderer:
 *
 *   story.js + story.css   the link page — an HTML shell fetches them
 *   app.html               the in-chat app — ONE file, nothing fetched
 *
 * The app variant exists because an MCP App is sandboxed with `default-src
 * 'none'`: a second request for a script, a stylesheet or a font is not slow,
 * it is refused. So its JS and CSS are inlined into the document and its
 * typeface is the reader's own (see `app-styles.css`).
 *
 * Run it with `pnpm --filter story-view bundle`. The API's own build runs it
 * too, so a release always ships the bundle built from that release's
 * components — the version-skew answer is "they are never separately
 * versioned", not a manifest to keep in step.
 *
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const out = path.resolve(pkg, '../../apps/api/public/story');

mkdirSync(out, { recursive: true });

/** Both variants are the same bundle settings over a different entry. */
function bundle(entry, outfile) {
  return esbuild.build({
    entryPoints: [path.join(here, entry)],
    ...(outfile ? { outfile } : { write: false }),
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    // The components carry `"use client"` for Next; a plain browser bundle has
    // no such notion and esbuild would otherwise warn once per file.
    logOverride: { 'unsupported-jsx-comment': 'silent', 'ignored-directive': 'silent' },
  });
}

function styles(config, input, outfile) {
  execFileSync(
    path.join(pkg, 'node_modules/.bin/tailwindcss'),
    [
      '-c', path.join(here, config),
      '-i', path.join(here, input),
      '-o', outfile,
      '--minify',
    ],
    { stdio: 'inherit' },
  );
  return readFileSync(outfile, 'utf8');
}

await bundle('entry.tsx', path.join(out, 'story.js'));
styles('tailwind.config.cjs', 'styles.css', path.join(out, 'story.css'));

// The app: same components, one file. Tailwind only writes to a path, so its
// output lands in a scratch directory and is read back to be inlined.
const scratch = mkdtempSync(path.join(tmpdir(), 'story-app-'));
try {
  const built = await bundle('app-entry.tsx', null);
  const script = built.outputFiles[0].text;
  const css = styles('app.tailwind.config.cjs', 'app-styles.css', path.join(scratch, 'app.css'));

  writeFileSync(
    path.join(out, 'app.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>What this automation does</title>` +
      `<style>${css}</style>` +
      `</head><body><div id="story-root"></div>` +
      // `</script` is the only sequence that can end a script block early, and
      // the bundle is minified JS that may legitimately contain it in a string.
      `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>` +
      `</body></html>`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`story bundle → ${out}`);
