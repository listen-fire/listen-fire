// The handbook section is held as a host holds a `plugin:*` chapter: the
// handbook's prose contract, and its probe admitted by the check a run passes,
// against the handbook's catalog with these plugins added.

import { pluginKey } from 'movement-lang';
import { pluginSpecsOf } from 'engine-contracts/plugin_spec';
import { proseViolations } from 'handbook';
import { HANDBOOK_CATALOG, admitProbe } from 'handbook/testing';

import { JEV_HANDBOOK_SECTION, JEV_PLUGINS } from '../index';

const PACKAGE = '@lf/jev';
const catalog = {
  ...HANDBOOK_CATALOG,
  plugins: {
    ...HANDBOOK_CATALOG.plugins,
    ...Object.fromEntries(Object.entries(pluginSpecsOf(JEV_PLUGINS)).map(([name, spec]) => [pluginKey(PACKAGE, name), { ...spec, package: PACKAGE, name }])),
  },
};

describe('the @lf/jev handbook section', () => {
  it('keeps the prose contract', () => {
    expect(proseViolations({ id: 'plugin:jev', ...JEV_HANDBOOK_SECTION })).toEqual([]);
  });

  it.each((JEV_HANDBOOK_SECTION.engineClaims ?? []).map((claim) => [claim.construct, claim] as const))('%s is admitted', (_, claim) => {
    expect(() => admitProbe(claim, catalog)).not.toThrow();
  });

  it('is checked against the plugins rather than passing blind: a missing argument and a misread answer are refused', () => {
    const [claim] = JEV_HANDBOOK_SECTION.engineClaims ?? [];
    if (claim === undefined) throw new Error('the section has no probe');
    const refused = (from: string, to: string) => {
      expect(claim.probe).toContain(from);
      return () => admitProbe({ ...claim, probe: claim.probe.replace(from, to) }, catalog);
    };
    expect(refused(', "Is this email asking us to meet or to buy something?")', ')')).toThrow(/MOV_THROUGH_ARG_MISSING.*'question'/);
    expect(refused('wanted >= 0.7', 'Text.length(wanted) >= 0.7')).toThrow(/MOV_BUILTIN_ARG_TYPE/);
    expect(refused('jev.classify({ subject: m.Subject, body: m.Body }', 'jev.classify(m')).toThrow(/MOV_CALL_ARG_TYPE.*'subject'/);
  });
});
