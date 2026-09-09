import { option, Options } from 'clime';

class UserOptions extends Options {
  @option({
    flag: 'u',
    description: 'user email',
    default: 'cli@listen-fire.local',
  })
  // Note the ! because we are in TS strict mode: https://stackoverflow.com/a/50241920/2180721
  email!: string;
}

export { UserOptions };
