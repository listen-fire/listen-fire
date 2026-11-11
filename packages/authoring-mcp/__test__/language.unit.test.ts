// The language half: the check (its diagnostics carry the handbook anchor
// that shows the fix, and readHandbook serves that anchor), the save refusal
// rule, the digest of connected systems, and the handbook as the tools serve
// it.

import { HANDBOOK_POINTER_BY_CODE, type PositionSchema } from 'movement-lang';

import { authoringDiagnostics, checkProgram, listensOf, unsavedRefusal, validationOf } from '../check';
import { describeFromSnapshot, renderConnectionsDigest } from '../digest';
import { readHandbook, searchHandbook } from '../handbook';
import type { TenantCatalog } from '../host';
import { CATALOG, PRELUDE, fileAs } from './fixtures';

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

  it('counts a listen written over a union as one listen, with one plan', () => {
    const note: PositionSchema = { properties: { Text: 'text' }, edges: {} };
    const subject: PositionSchema = { properties: { Name: 'text' }, edges: { Notes: { target: 'Note', listenable: true, delivery: 'connection' } } };
    const snapshot: TenantCatalog['snapshot'] = {
      ...CATALOG.snapshot,
      adapters: {
        ...CATALOG.snapshot.adapters,
        crm: {
          ...CATALOG.snapshot.adapters.crm,
          schemas: {
            workspace: {
              positions: { Person: subject, Company: subject, Note: note },
              unions: { Subject: ['Company', 'Person'] },
              collections: { Subjects: { target: 'Subject' } },
              writableRoots: {},
            },
          },
        },
      },
    };
    const source = `${PRELUDE}
function noted(n: <app-[:Note]->>) { return n.Text }

listen to app-[:Subjects]->-[:Notes]-> fire noted
listen to app-[:Subjects]->-[:Nowhere]-> fire noted
`;
    expect(listensOf(source, snapshot)).toEqual({ plans: [expect.objectContaining({ movement: 'noted', members: [expect.anything(), expect.anything()] })], written: 2 });
  });
});

describe('the digest of connected systems', () => {
  it('constructs each system and lists its record types with their fields, marking those a listen can start on', () => {
    const digest = renderConnectionsDigest(CATALOG);
    expect(digest).toContain('### crm — `connect #crm using workspace`');
    expect(digest).not.toContain('listen {');
    expect(digest.split('\n')[0]).toBe('plain edges read; [r w fires] read, write, listen; ! required, * identifying, ~ read only');
    expect(digest).toContain('- -[:Company]-> Company [r w fires]: Name! text, Stage "Lead" | "Customer"');
    expect(digest).toContain('### manual — `listen to manual-[:…]->` (in scope with no import or connect)');
    expect(digest).toContain('- -[:Invocations]-> Invocation [fires]: `Fired at` date, Text text');
    expect(digest).toContain('Not connected yet: mail.');
  });

  it('marks an edge readable only when it can be listed: a write-only edge and a listen-only edge are not', () => {
    const only: TenantCatalog = {
      ...CATALOG,
      snapshot: {
        ...CATALOG.snapshot,
        adapters: {
          ...CATALOG.snapshot.adapters,
          mail: {
            constructionArgs: [],
            canFire: true,
            schemaShape: 'introspected',
            schemas: {
              '': {
                positions: { Draft: { properties: { Body: 'text' }, edges: {} }, Tick: { properties: { Schedule: 'text' }, edges: {} } },
                collections: { Drafts: { target: 'Draft', readable: false }, Ticks: { target: 'Tick', readable: false, listenable: true } },
                writableRoots: { Draft: { fields: { Body: 'text' }, resultShape: { externalId: 'text' }, requiredFields: [] } },
              },
            },
          },
        },
      },
    };
    const digest = renderConnectionsDigest(only);
    expect(digest).toContain('- -[:Drafts]-> Draft [w]: Body text');
    expect(digest).toContain('- -[:Ticks]-> Tick [fires]: Schedule text');
  });

  it('describes a system at its root, and at a position its root handed out', () => {
    const root = describeFromSnapshot(CATALOG, { system: 'crm' });
    expect(root).toMatchObject({ ok: true, text: expect.stringContaining("The product's own CRM.") });
    expect(root.ok && root.text).toContain('- -[:Company]-> Company [r w fires]: Name! text, Stage "Lead" | "Customer"');
    expect(root.ok && root.text).toContain('position: "-[:Company]->"');
    const at = describeFromSnapshot(CATALOG, { system: 'crm', position: '-[:Company]->' });
    expect(at).toEqual({ ok: true, text: '### crm at -[:Company]->\nCompany: Name! text, Stage "Lead" | "Customer"\nedges: none' });
    expect(describeFromSnapshot(CATALOG, { system: 'nope' })).toMatchObject({ ok: false });
  });

  it('walks a position through the checker, so a misspelt edge is its diagnostic, and goes on past one hop', () => {
    const nowhere = describeFromSnapshot(CATALOG, { system: 'crm', position: '-[:Nowhere]->' });
    expect(nowhere).toMatchObject({ ok: true, text: expect.stringMatching(/^error MOV_TRAVERSE_UNKNOWN_EDGE .*'Nowhere' — it has: Company$/m) });
    const note: PositionSchema = { properties: { Text: 'text' }, edges: {} };
    const company: PositionSchema = { properties: { Name: 'text' }, edges: { Notes: { target: 'Note', writable: true } } };
    const deeper: TenantCatalog = {
      ...CATALOG,
      snapshot: {
        ...CATALOG.snapshot,
        adapters: {
          ...CATALOG.snapshot.adapters,
          crm: {
            ...CATALOG.snapshot.adapters.crm,
            schemas: {
              workspace: {
                positions: { Company: company, Note: note },
                collections: { Company: { target: 'Company' } },
                writableRoots: {},
                createShapes: { Note: { fields: { Text: 'text', Pinned: 'boolean' }, resultShape: {}, requiredFields: ['Text'] } },
              },
            },
          },
        },
      },
    };
    const at = describeFromSnapshot(deeper, { system: 'crm', position: '-[:Company]->' });
    expect(at.ok && at.text).toContain('- -[:Notes]-> Note [r w]: Text! text, Pinned boolean (write only)');
    expect(at.ok && at.text).toContain('position: "-[:Company]->-[:Notes]->"');
    const further = describeFromSnapshot(deeper, { system: 'crm', position: '-[:Company]->-[:Notes]->' });
    expect(further).toEqual({ ok: true, text: '### crm at -[:Company]->-[:Notes]->\nNote: Text! text, Pinned boolean (write only)\nedges: none' });
    const typed = describeFromSnapshot(deeper, { system: 'crm', types: ['Note', 'Nope'] });
    expect(typed.ok && typed.text).toContain('### crm type Note\nNote: Text! text');
    expect(typed.ok && typed.text).toContain('### crm type Nope\nNo such type. Types: Company, Note.');
  });

  it('describes a run host unit, which no address connects, from its root', () => {
    expect(describeFromSnapshot(CATALOG, { system: 'manual', position: '-[:Invocations]->' })).toEqual({
      ok: true,
      text: '### manual at -[:Invocations]->\nInvocation: `Fired at` date, Text text\nedges: none',
    });
    expect(describeFromSnapshot(CATALOG, { system: 'manual', position: '-[:Nope]->' })).toMatchObject({ ok: true, text: expect.stringContaining('No such place. Positions: -[:Invocations]->.') });
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

  // The catalog text and the index both send a schedule's author to system:cron.
  it("reads the units' chapters with no host, and a host's chapter of the same id in their place", () => {
    expect(readHandbook({ chapter: 'system:cron' })).toMatchObject({ content: expect.stringContaining('`Fired at`') });
    expect(readHandbook({ chapter: 'system:manual' })).toMatchObject({ content: expect.stringContaining('`Invocations`') });
    const host = { 'system:cron': { id: 'system:cron' as const, title: 'Schedules', content: '## Schedules\n\nThe host says.' } };
    expect(readHandbook({ chapter: 'system:cron' }, host)).toMatchObject({ content: expect.stringContaining('The host says.') });
  });
});
