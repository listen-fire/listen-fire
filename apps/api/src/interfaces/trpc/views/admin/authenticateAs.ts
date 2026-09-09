import { z } from 'zod';

import { trpc } from '../../trpc';
import { currentContext } from '../../../../services/context';
import { generateJWT } from '../../../../lib/middleware/authentication/token';
import { notNull } from '../../../../lib/utils/nullability';

const authenticateAsRouter = (procedure: typeof trpc.procedure) =>
  trpc.router({
    usersByEmailPrefix: procedure
      .input(
        z.object({
          emailPrefix: z.string(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();

        const users = await ctx.prisma.user.findMany({
          where: {
            grantedAccessAt: { not: null },
            OR: [
              {
                userEmails: {
                  some: {
                    email: {
                      startsWith: input.emailPrefix,
                    },
                    isPrimary: true,
                  },
                },
              },
              {
                username: {
                  contains: input.emailPrefix,
                  mode: 'insensitive',
                },
              },
            ],
          },
          include: {
            userEmails: true,
          },
          take: 20,
        });

        return Promise.all(
          users.map(async (user) => {
            const email = user.userEmails.find((email) => email.isPrimary)?.email;
            if (!email) {
              return null;
            }

            const token = await generateJWT(email);
            return {
              id: user.id,
              email,
              token,
              name: user.username,
            };
          }),
        ).then((users) => users.filter(notNull));
      }),
  });

export { authenticateAsRouter };
