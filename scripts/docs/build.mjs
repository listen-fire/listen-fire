// Builds the documentation site from the repo's own docs into `site/`.
// One section per compatibility key: `site/docs/<key>/<page>.html`, addressable
// as `/docs/<key>/<page>#<anchor>` (docs/README.md has the scheme). Plain Node,
// no dependencies. Run with `pnpm docs:build`.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './markdown.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// A pre-release build (DOCS_PREFIX=next) lands under `site/next/`, so it can sit beside the current docs.
const PREFIX = process.env.DOCS_PREFIX ?? '';
const siteDir = join(root, 'site', PREFIX);
// The deploy base lives in one place, beside the links the language server emits.
const SITE_URL = readFileSync(join(root, 'crates/movement-language/src/docs.rs'), 'utf8').match(/DOCS_SITE: &str = "([^"]+)"/)[1] + (PREFIX ? `/${PREFIX}` : '');
const REPO_URL = 'https://github.com/listen-fire/listen-fire';

// The release version comes from Cargo.toml. The compatibility key is the part of it a pin must share
// with the release: the minor under 0.x (`0.12`), the major from 1.0 (`1`). Source of truth:
// `compatibility_key` in crates/movement-parser/src/version.rs (and language_version.ts); the
// language server derives the same slug from the same version, so the two cannot drift.
const VERSION = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1];
const compatibilityKey = (version) => {
  const [, major, minor] = version.match(/^(\d+)\.(\d+)\.\d+(?:-.*)?$/) ?? [];
  if (major === undefined) throw new Error(`${version} is not a version`);
  return major === '0' ? `0.${minor}` : major;
};
const KEY = compatibilityKey(VERSION);
// A pre-release build (a `-` suffix) publishes under `docs/next/`, beside the current `docs/<key>/`.
const PRERELEASE = VERSION.includes('-') && process.env.DOCS_FORCE_STABLE !== '1';
const VERSIONS = [{ key: KEY, slug: PRERELEASE ? 'next' : KEY }];
const CURRENT = VERSIONS[VERSIONS.length - 1];
// Links released before the key scheme (`/docs/v5/<page>#<anchor>`) keep resolving: see writeLegacyRedirects.
const LEGACY_SLUG = 'v5';

const HANDBOOK_DIR = 'packages/handbook/chapters';
// Reading order; the in-app handbook's own order of registration.
const HANDBOOK_CHAPTERS = [
  'foundations', 'anatomy', 'expressions', 'writes', 'traversal', 'extraction', 'branching',
  'listeners', 'asks', 'patterns', 'use_cases', 'runs', 'reference', 'builtins',
];

const read = (path) => readFileSync(join(root, path), 'utf8');

// Chapters whose text travels with the language (the language service reads it too): the module reads this file.
const LANGUAGE_SIDE = { builtins: 'crates/movement-language/src/builtins.md' };

/** A chapter is a TypeScript module whose `content` is one template literal with every backtick and `${` escaped. */
function readChapter(name) {
  const text = read(`${HANDBOOK_DIR}/${name}.ts`);
  if (name in LANGUAGE_SIDE) {
    const title = text.match(/title:\s*(['"`])(.*?)\1/)?.[2] ?? name;
    return { title, content: read(LANGUAGE_SIDE[name]) };
  }
  const start = text.indexOf('content: `');
  if (start === -1) throw new Error(`${name}: no content template literal`);
  const bodyStart = start + 'content: `'.length;
  let end = bodyStart;
  while (end < text.length) {
    if (text[end] === '\\') end += 2;
    else if (text[end] === '`') break;
    else end++;
  }
  const title = text.match(/title:\s*(['"`])(.*?)\1/)?.[2] ?? name;
  const content = new Function(`return \`${text.slice(bodyStart, end)}\``)();
  return { title, content };
}

/** @type {{ page: string; title: string; group: string; source: string; markdown: string }[]} */
const pages = [];
const addFile = (group, page, source, title) => {
  const markdown = read(source);
  pages.push({ page, group, source, markdown, title: title ?? markdown.match(/^#\s+(.+)$/m)?.[1] ?? page });
};

for (const name of HANDBOOK_CHAPTERS) {
  const { title, content } = readChapter(name);
  const page = name.replace(/_/g, '-');
  pages.push({ page, group: 'Language handbook', source: LANGUAGE_SIDE[name] ?? `${HANDBOOK_DIR}/${name}.ts`, markdown: content, title });
}
addFile('Guides', 'getting-started-lf', 'docs/getting-started-lf.md');
addFile('Guides', 'core-slots', 'docs/core-slots.md');
addFile('Guides', 'lf-json', 'docs/lf-json.md');
addFile('Guides', 'embedding', 'docs/embedding.md');
addFile('Guides', 'adapter-protocol', 'docs/adapter-protocol.md');
addFile('Guides', 'migrating-to-0.12', 'docs/language/migrating-to-0.12.md');
for (const name of ['README', 'language-versions', 'catalog-snapshot', 'host-families', 'store-slot', 'limiter-slot', 'run-limits', 'park-state', 'system-caller', 'story-analysis', 'adapter-protocol']) {
  addFile('Contracts', name === 'README' ? 'contracts' : `contracts-${name}`, `docs/contracts/${name}.md`, name === 'README' ? 'Contracts' : undefined);
}

const pageBySource = new Map(pages.map((p) => [p.source, p.page]));
pageBySource.set('docs/contracts', 'contracts');
// The guide's old filename, still linked from released text.
pageBySource.set('docs/language/dancing-wren-migration.md', 'migrating-to-0.12');

function linkResolver(source) {
  return (href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return href;
    const [path, hash = ''] = href.split('#');
    const target = posix.normalize(posix.join(posix.dirname(source), path)).replace(/\/$/, '');
    const page = pageBySource.get(target);
    if (page) return `${page}.html${hash ? `#${hash}` : ''}`;
    const kind = /\.[a-z0-9]+$/i.test(target) ? 'blob' : 'tree';
    return `${REPO_URL}/${kind}/main/${target}${hash ? `#${hash}` : ''}`;
  };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const GROUPS = ['Guides', 'Language handbook', 'Contracts'];

function layout({ version, page, title, body, toc }) {
  const nav = GROUPS.map(
    (group) =>
      `<h2>${group}</h2><ul>${pages
        .filter((p) => p.group === group)
        .map((p) => `<li><a href="${p.page}.html"${p.page === page ? ' aria-current="page"' : ''}>${esc(p.title.replace(/^[A-Z]/, (c) => c))}</a></li>`)
        .join('')}</ul>`,
  ).join('');
  const options = VERSIONS.map(
    (v) => `<option value="../${v.slug}/${page}.html"${v.slug === version.slug ? ' selected' : ''}>${v.key}${v.slug === 'next' ? ' (pre-release)' : ''}</option>`,
  ).join('');
  const onPage = toc.filter((h) => h.level >= 2 && h.level <= 3);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · listen-fire docs ${version.key}</title>
<link rel="canonical" href="${SITE_URL}/docs/${version.slug}/${page}.html">
<style>
:root{--bg:#fff;--fg:#1d2127;--muted:#5c6570;--line:#dfe3e8;--code:#f4f6f8;--accent:#2457c5}
@media(prefers-color-scheme:dark){:root{--bg:#14171b;--fg:#e4e7eb;--muted:#9aa4af;--line:#2b3138;--code:#1e2328;--accent:#7ea6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif;display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
nav.side{border-right:1px solid var(--line);padding:16px;position:sticky;top:0;height:100vh;overflow:auto;font-size:14px}
nav.side h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:20px 0 6px}
nav.side ul{list-style:none;margin:0;padding:0}nav.side a{display:block;padding:2px 0;color:var(--fg);text-decoration:none}
nav.side a[aria-current]{color:var(--accent);font-weight:600}nav.side select{width:100%;font:inherit;padding:4px}
main{padding:24px clamp(16px,4vw,56px);max-width:900px;width:100%}
a{color:var(--accent)}a.anchor{opacity:0;text-decoration:none;margin-left:.3em}h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:.6}
code{background:var(--code);padding:.1em .3em;border-radius:3px;font-size:.9em}pre{background:var(--code);padding:12px;border-radius:6px;overflow:auto}pre code{padding:0;background:none}
.table-wrap{overflow:auto}table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:4px 10px;text-align:left;vertical-align:top}
blockquote{margin:0;padding:0 16px;border-left:3px solid var(--line);color:var(--muted)}
@media(max-width:760px){body{display:block}nav.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}}
</style></head><body>
<nav class="side"><a href="index.html"><strong>listen-fire docs</strong></a>
<h2>Compatibility key</h2><select onchange="location.href=this.value" aria-label="Compatibility key">${options}</select>${nav}</nav>
<main><h1>${esc(title)}</h1>${page === 'index' ? '' : ''}${body}</main></body></html>`;
}

function build(version) {
  const dir = join(siteDir, 'docs', version.slug);
  mkdirSync(dir, { recursive: true });
  for (const p of pages) {
    const { html, headings } = renderMarkdown(p.markdown, { resolveLink: linkResolver(p.source) });
    // The source's own top heading is the page title already shown above it.
    const body = html.replace(/^<h1 id="[^"]*">[\s\S]*?<\/h1>\n?/, '');
    writeFileSync(join(dir, `${p.page}.html`), layout({ version, page: p.page, title: p.title.replace(/^#+\s*/, ''), body, toc: headings }));
  }
  const intro = `<p>Documentation for the ${version.key} language. Pages below are built from this repository at the release's tag.</p>${GROUPS.map(
    (g) => `<h2>${g}</h2><ul>${pages.filter((p) => p.group === g).map((p) => `<li><a href="${p.page}.html">${esc(p.title)}</a></li>`).join('')}</ul>`,
  ).join('')}`;
  writeFileSync(join(dir, 'index.html'), layout({ version, page: 'index', title: `listen-fire ${version.key}`, body: intro, toc: [] }));
}

/** `/docs/v5/<page>#<anchor>` links were published before the key scheme; each page redirects to the same page and anchor under the key. */
function writeLegacyRedirects(version) {
  const dir = join(siteDir, 'docs', LEGACY_SLUG);
  mkdirSync(dir, { recursive: true });
  for (const page of [...pages.map((p) => p.page), 'index']) {
    const target = `../${version.slug}/${page}.html`;
    // The meta refresh drops a #fragment, so the script re-appends location.hash.
    writeFileSync(
      join(dir, `${page}.html`),
      `<!doctype html><meta charset="utf-8"><title>listen-fire docs ${version.key}</title><meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)} + location.hash)</script><a href="${target}">listen-fire docs ${version.key}</a>`,
    );
  }
}

// A pre-release leaves whatever else is in `site/` (the current docs) alone.
if (PRERELEASE) rmSync(join(siteDir, 'docs', CURRENT.slug), { recursive: true, force: true });
else rmSync(siteDir, { recursive: true, force: true });
for (const v of VERSIONS) build(v);
if (!PRERELEASE) writeLegacyRedirects(CURRENT);
if (!PRERELEASE) writeFileSync(
  join(siteDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>listen-fire docs</title><meta http-equiv="refresh" content="0;url=docs/${CURRENT.slug}/index.html"><a href="docs/${CURRENT.slug}/index.html">listen-fire docs</a>`,
);
mkdirSync(siteDir, { recursive: true });
writeFileSync(join(siteDir, '.nojekyll'), '');
console.log(`docs: built ${pages.length} pages x ${VERSIONS.length} version(s) into ${relative(root, siteDir)}/`);
