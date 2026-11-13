// A plugin declares what the checker and a host may rely on: that it is pure
// (same arguments, same answer until the host says otherwise) and for how long
// an answer may be kept. Absent is not pure.

import { LANGUAGE_VERSION, checkSourceInRust, type CatalogSnapshot } from 'movement-lang';

import type { ExpressionType } from '../catalog';
import { pluginSpecOf, pluginSpecsOf, type PluginDeclaration } from '../plugin_spec';
import { WirePluginSpec } from '../protocol';

const declaration = (more: Partial<PluginDeclaration> = {}): PluginDeclaration => ({
  priced: false,
  signature: {
    name: 'is-member',
    description: 'Whether the address belongs to a member.',
    params: [{ name: 'email', type: { kind: 'string' }, required: true, description: 'The address.' }],
    dataDependency: 'none',
    additions: {},
    effects: {},
    output: { kind: 'value', type: { kind: 'boolean' } },
  },
  ...more,
});

describe('a plugin declares itself pure', () => {
  it('a_plugin_declares_itself_pure_with_a_maximum_age', () => {
    const spec = pluginSpecOf(declaration({ pure: true, maxAgeSeconds: 60 }));
    expect(spec.pure).toBe(true);
    expect(spec.maxAgeSeconds).toBe(60);
    expect(WirePluginSpec.safeParse(spec).success).toBe(true);
  });

  it('absent means not pure, and says nothing of an age', () => {
    const spec = pluginSpecOf(declaration());
    expect(spec).not.toHaveProperty('pure');
    expect(spec).not.toHaveProperty('maxAgeSeconds');
  });

  it('a pure plugin may omit its age', () => {
    expect(pluginSpecOf(declaration({ pure: true }))).not.toHaveProperty('maxAgeSeconds');
  });

  it('refuses an age without purity at the boundary', () => {
    const wire = { args: ['email'], priced: false, argTypes: {}, maxAgeSeconds: 60 };
    const refused = WirePluginSpec.safeParse(wire);
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain("'maxAgeSeconds' is the age of a pure plugin's answer");
    expect(WirePluginSpec.safeParse({ ...wire, pure: false }).success).toBe(false);
    expect(WirePluginSpec.safeParse({ ...wire, pure: true }).success).toBe(true);
  });

  it('refuses an age that is not a whole number of seconds above zero', () => {
    const wire = { args: [], priced: false, argTypes: {}, pure: true };
    for (const maxAgeSeconds of [0, -1, 1.5]) expect(WirePluginSpec.safeParse({ ...wire, maxAgeSeconds }).success).toBe(false);
  });
});

describe('a plugin argument may ask for a brand', () => {
  it('a branded argument type rides a wire spec to the checker untouched', () => {
    const email = { kind: 'branded', of: 'text', brands: ['claim:email/address'] };
    const parsed = WirePluginSpec.parse({ args: ['email'], priced: false, argTypes: { email }, pure: true });
    expect(parsed.argTypes.email).toEqual(email);
  });
});

describe('a TypeScript plugin declaration may ask for a brand', () => {
  const brand = (name: string): ExpressionType => ({ kind: 'branded', of: { kind: 'string' }, brands: [name] });
  const email = brand('claim:email/address');
  const phone = brand('claim:phone/e164');
  const withParam = (type: ExpressionType): PluginDeclaration =>
    declaration({ signature: { ...declaration().signature, name: 'is-member', params: [{ name: 'email', type, required: true, description: 'The address.' }] } });

  it('projects a branded parameter to the catalog branded type', () => {
    const spec = pluginSpecOf(withParam(email));
    expect(spec.argTypes?.email).toEqual({ kind: 'branded', of: 'text', brands: ['claim:email/address'] });
    expect(WirePluginSpec.safeParse(spec).success).toBe(true);
  });

  it('projects a union of branded types to the catalog union', () => {
    const spec = pluginSpecOf(withParam({ kind: 'union', of: [email, phone] }));
    expect(spec.argTypes?.email).toEqual({
      kind: 'union',
      of: [
        { kind: 'branded', of: 'text', brands: ['claim:email/address'] },
        { kind: 'branded', of: 'text', brands: ['claim:phone/e164'] },
      ],
    });
    expect(WirePluginSpec.parse(spec).argTypes.email).toEqual(spec.argTypes?.email);
  });

  it('a plugin declared this way makes the Rust checker refuse plain text with MOV_BRAND_REQUIRED', () => {
    const plugins = pluginSpecsOf([withParam({ kind: 'union', of: [email, phone] })]);
    const snapshot = { adapters: {}, credentials: {}, plugins: { is_member: { ...plugins.is_member, package: '@lf-platform/team' } } } as unknown as CatalogSnapshot;
    const check = (argument: string) =>
      checkSourceInRust(`import { \`@lf-platform/team\` as t } from plugins\nr = t.isMember(${argument})\n`, snapshot, { languageVersion: LANGUAGE_VERSION });
    const refused = check('"a@x.com"').filter((d) => d.code === 'MOV_BRAND_REQUIRED');
    expect(refused).toHaveLength(1);
    expect(refused[0].message).toContain('text & Brand<"claim:email/address"> | text & Brand<"claim:phone/e164">');
  });
});
