import * as db from '@prisma/client';

import { MQ } from '../native';

const profilesExchange = new MQ<db.LegalEntity>().setPresets({
  created: {
    name: 'created',
    type: 'fanout',
  },
});

export { profilesExchange };
