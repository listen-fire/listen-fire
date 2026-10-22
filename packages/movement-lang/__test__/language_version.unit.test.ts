import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  LANGUAGE_VERSION,
  compatibilityKey,
  compatible,
  languageVersionDiagnostic,
  languageVersionStanding,
  type LanguageVersionStanding,
} from '../language_version';

describe('a pin is read when its compatibility key is the release\'s', () => {
  const table: ReadonlyArray<[string, string, LanguageVersionStanding]> = [
    ['0.12.3', '0.12.0', 'compatible'],
    ['0.13.0', '0.12.0', 'newer'],
    ['0.11.0', '0.12.0', 'olderKey'],
    ['1.4.0', '1.0.0', 'compatible'],
    ['2.0.0', '1.9.0', 'newer'],
    ['0.12.0-rc.6', '0.12.0', 'compatible'],
    ['banana', '0.12.0', 'malformed'],
  ];
  it.each(table)('%s against %s is %s', (pin, own, standing) => {
    expect(languageVersionStanding(pin, own)).toBe(standing);
    expect(compatible(pin, own)).toBe(standing === 'compatible');
  });

  it('the key is the minor under 0.x and the major from 1.0', () => {
    expect(compatibilityKey('0.12.0-rc.6')).toBe('0.12');
    expect(compatibilityKey('1.4.2')).toBe('1');
    for (const malformed of ['banana', '5', '0.12', '0.12.0.1', '01.2.3', '0.12.0-', '0.12.0-rc..1', '']) {
      expect(compatibilityKey(malformed)).toBeUndefined();
    }
  });
});

describe('each refusal names the pin, the release and the remedy', () => {
  const message = (pin: string) => languageVersionDiagnostic(pin, '0.12.0')?.message;
  it('reads a compatible pin silently', () => {
    expect(languageVersionDiagnostic('0.12.1', '0.12.0')).toBeUndefined();
  });
  it('words the three refusals as the Rust does', () => {
    expect(message('0.13.0')).toBe('this automation pins language 0.13.0, newer than this release (0.12.0); upgrade the engine');
    expect(message('0.11.0')).toBe(
      'this automation pins language 0.11.0, which this release (0.12.0) does not read; validate it under 0.12.0 and upgrade it',
    );
    expect(message('banana')).toBe(
      "this automation pins language banana, which is not a version; a pin is a release's version, such as 0.12.0",
    );
    expect(languageVersionDiagnostic('0.11.0', '0.12.0')?.code).toBe('MOV_LANGUAGE_VERSION_UNSUPPORTED');
  });
});

describe('the language version is the package\'s', () => {
  it('is package.json\'s version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as { version: string };
    expect(LANGUAGE_VERSION).toBe(manifest.version);
    expect(compatible(LANGUAGE_VERSION, LANGUAGE_VERSION)).toBe(true);
  });
});
