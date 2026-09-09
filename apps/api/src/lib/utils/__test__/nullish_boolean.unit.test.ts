import { nullishBoolean } from '../nullish_boolean';

describe('nullishBoolean', () => {
  [
    { title: 'null does not throw', input: null, expected: null },
    { title: 'undefined does not throw', input: undefined, expected: undefined },
    { title: 'valid true', input: true, expected: true },
    { title: 'valid false', input: false, expected: false },
    { title: 'string "true" in any case and with spaces', input: ' True ', expected: true },
    { title: 'string "false" in any case and with spaces', input: ' falSE ', expected: false },
    { title: 'string "0" and with spaces', input: ' 0 ', expected: false },
    { title: 'string "1" and with spaces', input: ' 1 ', expected: true },
    { title: 'any other string is false', input: ' 1 1 ', expected: false },
    { title: 'number 1 is true', input: 0, expected: false },
    { title: 'number 0 is false', input: 1, expected: true },
    { title: 'any other number is null', input: 2, expected: null },
    { title: 'any other type is null', input: [], expected: null },
  ].forEach(({ title, input, expected }) => {
    it(title, () => expect(nullishBoolean.parse(input)).toEqual(expected));
  });
});
