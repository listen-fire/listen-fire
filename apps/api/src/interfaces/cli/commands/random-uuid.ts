import crypto from 'node:crypto';

import { Command, command, metadata, param } from 'clime';

function main(n: number) {
  let i = 0;
  while (i < n) {
    console.warn(crypto.randomUUID());
    i++;
  }
}

@command({ description: 'Generate random UUID' })
export default class extends Command {
  @metadata
  execute(
    @param({
      description: 'number of UUIDs to generate',
      required: false,
      default: 1,
    })
    n: number,
  ) {
    main(n);
  }
}
