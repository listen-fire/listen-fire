// The language half: the check (its diagnostics carry the handbook anchor
// that shows the fix, and readHandbook serves that anchor), the save refusal
// rule, the digest of connected systems, and the handbook as the tools serve
// it.

import { HANDBOOK_POINTER_BY_CODE } from 'movement-lang';

import { authoringDiagnostics, checkProgram, unsavedRefusal, validationOf } from '../check';
import { describeFromSnapshot, renderConnectionsDigest } from '../digest';
import { readHandbook, searchHandbook } from '../handbook';
import { CATALOG, fileAs } from './fixtures';

const check = (source: string) => checkProgram({ source, catalog: CATALOG.snapshot });

describe('the check', () => {
  it('passes a program that matches the catalog', async () => {
    expect(await check(fileAs('Lead'))).toEqual({ diagnostics: [], ok: true, version: expect.any(String) });
  });

  it("refuses a value the tenant's select does not have", async () => {
    const result = await check(fileAs('Prospect'));
    expect(result.ok).toBe(false);
    expect(authoringDiagnostics(fileAs('Prospect'), result.diagnostics)).toEqual([
      expect.objectContaining({ code: 'MOV_ENUM_UNKNOWN_VALUE', severity: 'error', line: 7, sourceLine: expect.stringContaining('Stage: "Prospect"') }),
    ]);
  });

  it('gives each diagnostic the handbook anchor that shows its fix, and readHandbook serves it', async () => {
    const source = fileAs('Lead').replace('  write app', '  x = SHOUT(run.Text)\n  write app');
    const [diagnostic] = authoringDiagnostics(source, (await check(source)).diagnostics).filter((d) => d.code === 'MOV_FUNCTION_UNKNOWN');
    expect(diagnostic).toMatchObject({ handbook: 'front#functions-not-methods', line: 7, sourceLine: '  x = SHOUT(run.Text)' });
    const read = readHandbook({ chapter: diagnostic.handbook });
    expect(read).toMatchObject({ handbook: 'automations', chapter: 'front', section: 'functions-not-methods', content: expect.any(String) });
  });

  it('every anchor a diagnostic can carry resolves in the handbook', () => {
    for (const anchor of new Set(Object.values(HANDBOOK_POINTER_BY_CODE))) {
      expect([anchor, readHandbook({ chapter: anchor })]).toEqual([anchor, expect.objectContaining({ content: expect.any(String) })]);
    }
  });

  it('answers a text that does not parse with one diagnostic at its place', async () => {
    const result = await check('import {');
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'MOV_PARSE', span: { start: { line: 1, col: 9 } } }] });
  });

  it('refuses to save while anything blocks, or while a system could not be checked', async () => {
    const broken = await check(fileAs('Prospect'));
    expect(unsavedRefusal(broken, validationOf(fileAs('Prospect'), broken))).toMatchObject({ ok: false, saved: false, message: expect.stringMatching(/has errors/) });
    const clean = await check(fileAs('Lead'));
    expect(unsavedRefusal(clean, validationOf(fileAs('Lead'), clean))).toBeNull();
    const unverified = { ...clean, unverified: ['crm (timed out)'] };
    expect(unsavedRefusal(unverified, validationOf(fileAs('Lead'), unverified))).toMatchObject({ errors: ['crm (timed out)'], message: expect.stringMatching(/could not be checked/) });
  });
});

describe('the digest of connected systems', () => {
  it('constructs each system, says what its listen may say, and lists its record types with their fields', () => {
    const digest = renderConnectionsDigest(CATALOG);
    expect(digest).toContain('### crm — `crm(credentials: workspace)`');
    expect(digest).toContain('- listen { events: company.created }');
    expect(digest).toContain('- Company [rw fires]: Name text!, Stage enum(Lead|Customer)');
    expect(digest).toContain('### manual — `listen to manual` (in scope with no import or connect)');
    expect(digest).toContain('- Invocation [fires]: `Fired at` date, Text text');
    expect(digest).toContain('Not connected yet: mail.');
  });

  it('describes a system at its root, and at a position its root handed out', () => {
    const root = describeFromSnapshot(CATALOG, { system: 'crm' });
    expect(root).toMatchObject({ ok: true, text: expect.stringContaining("The product's own CRM.") });
    expect(root.ok && root.text).toContain('position: "-[:Company]->"');
    const at = describeFromSnapshot(CATALOG, { system: 'crm', position: '-[:Company]->' });
    expect(at).toEqual({ ok: true, text: '### crm at -[:Company]->\nCompany [rw fires]: Name text!, Stage enum(Lead|Customer)\nNo edges leave this node.' });
    expect(describeFromSnapshot(CATALOG, { system: 'crm', position: '-[:Nowhere]->' })).toMatchObject({ ok: true, text: expect.stringContaining('No such place') });
    expect(describeFromSnapshot(CATALOG, { system: 'nope' })).toMatchObject({ ok: false });
  });
});

describe('the handbook as the tools serve it', () => {
  it('serves the front page, points a whole chapter at the search, and reads a section in full', () => {
    expect(readHandbook({ handbook: 'automations' })).toMatchObject({ chapter: 'front', content: expect.stringContaining('it is TypeScript, except') });
    expect(readHandbook({ chapter: 'writes' })).toMatchObject({ chapter: 'writes', note: expect.stringMatching(/searchLanguage/) });
    expect(readHandbook({ chapter: 'writes#identity' })).toMatchObject({ chapter: 'writes', section: 'identity', content: expect.any(String) });
    expect(readHandbook({ handbook: 'knowledge-model' })).toMatchObject({ error: expect.stringMatching(/No handbook/) });
  });

  it("reads and searches the host's own chapters beside the language's", () => {
    const chapters = { 'system:crm': { id: 'system:crm' as const, title: 'The CRM', content: '## The CRM\n\nCompanies, and the stage each is at.' } };
    expect(readHandbook({}, chapters)).toMatchObject({ shelf: [{ chapters: expect.arrayContaining([{ id: 'system:crm', title: 'The CRM' }]) }] });
    expect(readHandbook({ chapter: 'system:crm' }, chapters)).toMatchObject({ content: expect.stringContaining('Companies') });
    expect(searchHandbook({ query: 'COALESCE' }).results.length).toBeGreaterThan(0);
  });
});
