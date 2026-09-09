import * as db from '@prisma/client';

import { MQ } from '../native';

const usersExchange = new MQ<db.User>().setPresets({
  created: {
    name: 'created',
    type: 'fanout',
  },
});

export { usersExchange };
