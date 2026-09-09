import {
  movementsImportingCredential,
  referencedCredentialImports,
} from '../credential_dependents';

describe('referencedCredentialImports', () => {
  it('finds builtin credential imports, ignoring adapters and file imports', () => {
    const source = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'import { helpers } from "shared_shapes"',
      '',
      'movement sync(company) {',
      '  crm = attio(credentials: acme_main)',
      '}',
    ].join('\n');
    expect(referencedCredentialImports(source)).toEqual(['acme_main']);
  });

  it('returns the ORIGINAL name when the import is aliased', () => {
    const source = [
      'import { attio } from adapters',
      'import { acme_main as crm_creds } from credentials',
      '',
      'movement sync(company) {',
      '  crm = attio(credentials: crm_creds)',
      '}',
    ].join('\n');
    expect(referencedCredentialImports(source)).toEqual(['acme_main']);
  });

  it('collects multiple names from one import list', () => {
    const source = 'import { acme_main, acme_sheets } from credentials\n';
    expect(referencedCredentialImports(source)).toEqual(['acme_main', 'acme_sheets']);
  });

  it('falls back to a line scan when the program does not parse', () => {
    const source = [
      'import { acme_main as crm } from credentials',
      'movement broken( {{{', // unparsable mid-edit text
    ].join('\n');
    expect(referencedCredentialImports(source)).toEqual(['acme_main']);
  });

  it('returns nothing for a source without credential imports', () => {
    const source = 'import { email } from adapters\n';
    expect(referencedCredentialImports(source)).toEqual([]);
  });
});

describe('movementsImportingCredential', () => {
  const rows = [
    {
      id: 'm1',
      name: 'sync_companies',
      validityStatus: 'valid',
      source: 'import { acme_main } from credentials\n',
    },
    {
      id: 'm2',
      name: 'weekly_digest',
      validityStatus: null,
      source: 'import { other_account } from credentials\n',
    },
    {
      id: 'm3',
      name: 'no_credentials',
      validityStatus: 'valid',
      source: 'import { email } from adapters\n',
    },
  ];

  it('returns only rows importing one of the given names', () => {
    expect(movementsImportingCredential(rows, ['acme_main'])).toEqual([
      { id: 'm1', name: 'sync_companies', validityStatus: 'valid' },
    ]);
  });

  it('matches any of several import names (multi-adapter credential)', () => {
    expect(
      movementsImportingCredential(rows, ['acme_main', 'other_account']).map((m) => m.id),
    ).toEqual(['m1', 'm2']);
  });

  it('returns nothing when the credential has no import names', () => {
    expect(movementsImportingCredential(rows, [])).toEqual([]);
  });
});
