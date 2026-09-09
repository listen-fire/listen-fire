import { BinaryToTextEncoding, createHash, Hash } from 'node:crypto';
import { Transform } from 'node:stream';

import objectHash from 'object-hash';

type ChecksumOpts = {
  algorithm: string;
  encoding: BinaryToTextEncoding;
};

const hash = <T extends objectHash.NotUndefined>(
  object: T,
  options?: objectHash.NormalOption,
): string => objectHash(object, options);

class ChecksumTransform extends Transform {
  constructor(opts: ChecksumOpts = { algorithm: 'md5', encoding: 'hex' }) {
    super({
      transform: (chunk, encoding, callback) => {
        this._hash.update(chunk, encoding);
        this.push(chunk, encoding);
        callback();
      },
      flush: (callback) => {
        this._digest = this._hash.digest(opts.encoding);
        callback();
      },
    });

    this._hash = createHash(opts.algorithm);
  }

  private _hash: Hash;
  private _digest: string | null = null;

  getDigest() {
    if (!this._digest) {
      throw new Error('Digest not yet calculated');
    }
    return this._digest;
  }
}

function checksum(content: string, opts: ChecksumOpts = { algorithm: 'md5', encoding: 'hex' }) {
  return createHash(opts.algorithm).update(content).digest(opts.encoding);
}

export { hash, checksum, ChecksumTransform };
