import { z } from 'zod';

import { currentContext } from '../../../services/context';
import {
  startPhoneVerification,
  confirmPhoneVerification,
} from '../../../services/whatsapp/phone_verification';
import { trpc } from '../trpc';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { UserService } from '../../../services/user';
import { getKnowledgeQb } from '../../../lib/kysely';
import { WHATSAPP_MOVEMENTS_NUMBER } from '../../../services/translation_graph/adapters/whatsapp';
import { LISTEN_FIRE_VERSION } from '../../../constants';

const userSettingsRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    // Facts about the INSTALLATION rather than about the user: the release it
    // is running, and the number a person messages to reach it. Both are read
    // by the settings page and neither depends on who is asking, so they are
    // one query — a second one-off per deployment fact is how a settings page
    // ends up making five round trips to render a footer.
    //
    // `whatsappNumber` is null on an install with no WhatsApp sender
    // registered, and the WhatsApp section has nothing to offer then.
    getDeployment: userProcedure.query(() => ({
      version: LISTEN_FIRE_VERSION,
      whatsappNumber: WHATSAPP_MOVEMENTS_NUMBER,
    })),

    getPhoneNumber: userProcedure.query(async () => {
      const ctx = currentContext();
      const phoneNumber = await ctx.prisma.phoneNumber.findFirst({
        where: { userId: ctx.user.id },
      });
      return phoneNumber;
    }),

    updatePhoneNumber: userProcedure.input(z.string()).mutation(async ({ input: phoneNumber }) => {
      const ctx = currentContext();
      const res = await UserService.addPhoneNumber({ userId: ctx.user.id, phoneNumber });
      return res;
    }),

    // Send a WhatsApp verification code to the number the user is claiming.
    startPhoneVerification: userProcedure
      .input(z.object({ phoneNumber: z.string().min(6) }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        return startPhoneVerification({ userId: ctx.user.id, phoneNumber: input.phoneNumber });
      }),

    // Confirm the code — on success the phone becomes a verified, routable link.
    confirmPhoneVerification: userProcedure
      .input(z.object({ phoneNumber: z.string().min(6), code: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        return confirmPhoneVerification({
          userId: ctx.user.id,
          phoneNumber: input.phoneNumber,
          code: input.code,
        });
      }),

    // How the team's agents should talk lives with the agents
    // (`knowledge.team_agent_settings`), not on the team row.
    getAgentStylePreferences: userProcedure.query(async () => {
      const ctx = currentContext();
      const row = await getKnowledgeQb(['team_agent_settings'])
        .selectFrom('team_agent_settings')
        .select('style_preferences')
        .where('team_id', '=', ctx.user.teamId)
        .executeTakeFirst();
      return { preferences: row?.style_preferences ?? '' };
    }),
    updateAgentStylePreferences: userProcedure
      .input(z.object({ preferences: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const preferences = input.preferences || null;
        await getKnowledgeQb(['team_agent_settings'])
          .insertInto('team_agent_settings')
          .values({ team_id: ctx.user.teamId, style_preferences: preferences })
          .onConflict((oc) =>
            oc
              .column('team_id')
              .doUpdateSet({ style_preferences: preferences, updated_at: new Date() }),
          )
          .execute();
        return { success: true };
      }),
    getEmails: userProcedure.query(async () => {
      const ctx = currentContext();
      const emails = await ctx.prisma.userEmail.findMany({
        where: {
          userId: ctx.user.id,
        },
      });
      return emails.map((email) => ({
        id: email.id,
        email: email.email,
        isPrimary: email.isPrimary,
      }));
    }),
    updateUsername: userProcedure
      .input(
        z.object({
          username: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        await ctx.prisma.user.update({
          where: {
            id: ctx.user.id,
          },
          data: {
            username: input.username,
          },
        });

        return { success: true };
      }),
  });
};

export { userSettingsRouter };
