import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Client } from 'pg';

/**
 * The on-disk shape of an export, and the rules that make two exports of
 * unchanged data the same bytes.
 *
 * Values are carried as Postgres's OWN text representation — every column is
 * selected `::text` and re-inserted with a cast back to its declared type. It
 * costs one cast each way and buys exact fidelity for the types a JavaScript
 * round-trip mangles: bytea, jsonb, arrays, enums, timestamps, numerics. It
 * also means the bundle is readable, which matters for an artifact somebody
 * has to audit before handing a tenant their data.
 */

export const BUNDLE_FORMAT_VERSION = 1;
export const TOOL_VERSION = '1.0.0';

export type TableEntry = {
  /** Schema-qualified. */
  table: string;
  /** In ordinal order — the import refuses if the target's differ. */
  columns: string[];
  rows: number;
  sha256: string;
  file: string;
  /** Shared deployment data — the target's copy wins if it already has one. */
  referenceData?: true;
};

export type DeclinedEntry = { table: string; because: string };

export type BundleManifest = {
  formatVersion: number;
  tool: { name: string; version: string };
  /**
   * The ONLY value here that is not a function of the exported data — two runs
   * over unchanged rows differ in this field and nowhere else.
   */
  generatedAt: string;
  teamId: string;
  teamName: string | null;
  products: string[];
  /** The target must be at this migration, or the import refuses. */
  migrationHead: string;
  withHistory: boolean;
  tables: TableEntry[];
  /** What the export deliberately did not carry, and why. */
  declined: DeclinedEntry[];
};

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `manifest.json` last, so a half-written bundle has no manifest to trust. */
export async function writeBundle(
  dir: string,
  manifest: BundleManifest,
  files: Map<string, string>,
): Promise<void> {
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  for (const [name, contents] of files) {
    await fs.writeFile(path.join(dir, name), contents, 'utf8');
  }
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

export async function readBundle(dir: string): Promise<BundleManifest> {
  const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw) as BundleManifest;
  if (manifest.formatVersion !== BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `Bundle format version ${manifest.formatVersion} — this tool reads ${BUNDLE_FORMAT_VERSION}`,
    );
  }
  return manifest;
}

/**
 * Reads a table file back, checking the digest the manifest recorded. A bundle
 * that has been edited between export and import is refused rather than
 * partially trusted.
 */
export async function readTableFile(dir: string, entry: TableEntry): Promise<(string | null)[][]> {
  const contents = await fs.readFile(path.join(dir, entry.file), 'utf8');
  const digest = sha256(contents);
  if (digest !== entry.sha256) {
    throw new Error(
      `${entry.file} does not match its manifest digest (expected ${entry.sha256}, found ${digest})`,
    );
  }
  const lines = contents.split('\n').filter((l) => l.length > 0);
  return lines.map((line) => JSON.parse(line) as (string | null)[]);
}

/** A `pg` client, kept separate from the app's pool: this tool talks to a database it may not be able to boot against. */
export async function connect(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}
