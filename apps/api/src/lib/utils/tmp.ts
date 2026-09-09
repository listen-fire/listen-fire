import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import tmp from 'tmp';

// this registers a cleanup handler that will remove any tmp files on process exit
// see https://github.com/raszi/node-tmp#graceful-cleanup
tmp.setGracefulCleanup();

// TODO: rewrite this to use tmp rather than fs
// because it handles things like cleanup on process exit
/**
 * Put the contents of a readable stream into a temporary file so we can report the size.
 * Automatically clean up the tmp file on close.
 */
async function pipeThroughTmpFile(rs: Readable) {
  const tmpFilePath = path.join(tmpdir(), randomUUID());
  await pipeline(rs, createWriteStream(tmpFilePath));
  const { size } = await stat(tmpFilePath);

  const tmpReadStream = createReadStream(tmpFilePath);

  tmpReadStream.on('close', async () => {
    await rm(tmpFilePath);
  });

  return { data: tmpReadStream, size };
}

function tmpPromise() {
  return new Promise<[string, number, () => void]>((resolve, reject) => {
    tmp.file((err, _path, fd, cleanup) => {
      if (err) {
        reject(err);
      } else {
        resolve([_path, fd, cleanup]);
      }
    });
  });
}

export { pipeThroughTmpFile, tmpPromise };
