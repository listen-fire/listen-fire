import Hashids from 'hashids';
import { NumberLike } from 'hashids/cjs/util';

import { HASHIDS_SALT } from '../../constants';

// This is a reduced alphabet excluding upper case letters and il10o
// to avoid mistakes when manually copying
const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789' as const;

// gives entropy of about 800M permutations, though hashids will start using
// 7 characters for numbers above about 4M
const minLength = 6;

function encode(num: number | bigint, key: string) {
  const hashids = new Hashids(`${key}:${HASHIDS_SALT}`, minLength, alphabet);

  return hashids.encode(num);
}

function decode(encoded: string, key: string): NumberLike | undefined {
  const hashids = new Hashids(`${key}:${HASHIDS_SALT}`, minLength, alphabet);

  return hashids.decode(encoded)[0];
}

export { encode, decode };
