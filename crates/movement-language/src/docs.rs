//! Where the service's hovers link: the published documentation site. Every
//! target is a page and a heading of the site `pnpm docs:build` produces; the
//! `docs_links` test builds the site and checks each one resolves.

use movement_checker::scope::SymbolKind;

use crate::builtins;

/// Where the site is served from. The repository is `listen-fire/listen-fire`
/// on GitHub Pages without a custom domain; a custom domain changes this one
/// constant (`scripts/docs/build.mjs` reads it from here for its canonical links).
pub const DOCS_SITE: &str = "https://listen-fire.github.io/listen-fire";

/// The docs section this build links to: a pre-release build (a `-` in the crate version) links to
/// `docs/next/`, a plain version to `docs/<compatibility key>/`. `scripts/docs/build.mjs` derives the
/// same slug from the same version, so the two cannot drift.
pub const DOCS_SLUG: &str = docs_slug(env!("CARGO_PKG_VERSION"));

const fn docs_slug(version: &'static str) -> &'static str {
    if has_prerelease(version) { "next" } else { compatibility_key(version) }
}

/// The part of a version a pin must share with a release: the minor under 0.x (`0.12`), the major
/// from 1.0 (`1`). The same rule as `movement_parser::version::compatibility_key`, which allocates and
/// so cannot be const; the `docs_links` test holds the two equal.
const fn compatibility_key(version: &'static str) -> &'static str {
    let bytes = version.as_bytes();
    let major_end = dot_after(bytes, 0);
    let end = if bytes.len() > 1 && bytes[0] == b'0' && major_end == 1 { dot_after(bytes, major_end + 1) } else { major_end };
    match str::from_utf8(bytes.split_at(end).0) {
        Ok(key) => key,
        Err(_) => panic!("a crate version is ASCII"),
    }
}

/// The index of the first `.` at or after `from`, or the end.
const fn dot_after(bytes: &[u8], from: usize) -> usize {
    let mut i = from;
    while i < bytes.len() && bytes[i] != b'.' {
        i += 1;
    }
    i
}

const fn has_prerelease(version: &str) -> bool {
    let bytes = version.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'-' {
            return true;
        }
        i += 1;
    }
    false
}

/// `DOCS_SITE` plus `/docs/<DOCS_SLUG>`.
pub fn docs_base() -> String {
    format!("{DOCS_SITE}/docs/{DOCS_SLUG}")
}

pub fn docs_url(page: &str, anchor: &str) -> String {
    format!("{}/{page}#{anchor}", docs_base())
}

/// The handbook section a symbol of this kind is explained in.
pub fn page_of(kind: SymbolKind) -> (&'static str, &'static str) {
    match kind {
        SymbolKind::Binding | SymbolKind::Param => ("reference", "top-level"),
        SymbolKind::Movement => ("anatomy", "functions-and-calls"),
        SymbolKind::Shape => ("anatomy", "records-you-build"),
        SymbolKind::Type => ("anatomy", "declared-structures"),
        SymbolKind::Alias => ("traversal", "blocks"),
        SymbolKind::FileImport | SymbolKind::Plugin => ("anatomy", "imports"),
        SymbolKind::Adapter | SymbolKind::Instance | SymbolKind::Credential => ("anatomy", "constructions"),
    }
}

/// A record's field read off a value.
pub const FIELD: (&str, &str) = ("reference", "types-and-brackets");
/// An edge taken in a walk.
pub const WALK: (&str, &str) = ("traversal", "query-a-graph");

/// Every kind a symbol can have (the match in `page_of` is exhaustive; keep this list beside it).
const KINDS: [SymbolKind; 11] = [
    SymbolKind::Adapter,
    SymbolKind::Credential,
    SymbolKind::Plugin,
    SymbolKind::FileImport,
    SymbolKind::Binding,
    SymbolKind::Instance,
    SymbolKind::Param,
    SymbolKind::Movement,
    SymbolKind::Shape,
    SymbolKind::Alias,
    SymbolKind::Type,
];

/// The builtins chapter's heading for a built-in: its name as GitHub slugs it (`Text.upper` → `textupper`).
pub fn builtin_page(name: &str) -> (&'static str, String) {
    match name {
        "fail" => ("branching", "guard-with-error".into()),
        "callback" => ("asks", "a-callback-as-a-link".into()),
        _ => ("builtins", builtin_anchor(name)),
    }
}

pub fn builtin_anchor(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').map(|c| if c == ' ' { '-' } else { c.to_ascii_lowercase() }).collect()
}

/// Every link the service can put in a hover, as (page, anchor).
pub fn all_targets() -> Vec<(String, String)> {
    let fixed = KINDS.iter().map(|k| page_of(*k)).chain([FIELD, WALK]).map(|(p, a)| (p.to_string(), a.to_string()));
    let builtin = builtins::v5_builtins().into_iter().map(|b| builtin_page(b.name)).map(|(p, a)| (p.to_string(), a));
    fixed.chain(builtin).collect()
}
