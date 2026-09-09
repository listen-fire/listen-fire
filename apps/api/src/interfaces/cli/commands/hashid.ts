import { Command, Options, command, option, metadata } from 'clime';

import { decode, encode } from '../../../lib/hashids';

class CliOptions extends Options {
  @option({
    description: 'hashid to decode',
    flag: 'd',
    name: 'decode',
  })
  hashid?: string;
  @option({
    description: 'integer to encode',
    flag: 'e',
    name: 'encode',
  })
  integer?: number;
  @option({
    description: 'grouping key',
    flag: 'k',
    required: true,
  })
  key!: string;
}

@command({
  description:
    'Encode an integer into a hashid or decode a hashid.\n\nWill use the salt from the env var HASHIDS_SALT ',
})
export default class MyCommand extends Command {
  @metadata
  execute(options: CliOptions) {
    if (options.hashid && options.integer) {
      throw new Error('Either decode a hashid of encode a number, not both');
    }
    if (options.hashid) {
      return console.warn(decode(options.hashid, options.key));
    } else if (options.integer) {
      return console.warn(encode(options.integer, options.key));
    }
    return MyCommand.getHelp();
  }
}
