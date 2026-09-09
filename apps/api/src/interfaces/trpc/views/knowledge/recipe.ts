import { z } from 'zod';

import { getKnowledgeQb } from '../../../../lib/kysely';
import { currentContext } from '../../../../services/context';
import { trpc } from '../../trpc';
import { TeamId } from '../../../../generated/kysely/core/Team';
import { RecipeId } from '../../../../generated/kysely/knowledge/Recipe';
import { UserId } from '../../../../generated/kysely/core/User';
import { userProcedure as sharedUserProcedure } from '../../procedures';

const recipeRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    list: userProcedure.query(async () => {
      const ctx = currentContext();
      return getKnowledgeQb(['recipe'])
        .selectFrom('recipe')
        .where('team_id', '=', ctx.user.teamId as TeamId)
        .select(['id', 'name', 'description', 'instructions', 'created_at', 'updated_at'])
        .orderBy('name asc')
        .execute();
    }),

    get: userProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
      const ctx = currentContext();
      const recipe = await getKnowledgeQb(['recipe'])
        .selectFrom('recipe')
        .where('id', '=', input.id as RecipeId)
        .where('team_id', '=', ctx.user.teamId as TeamId)
        .select(['id', 'name', 'description', 'instructions', 'created_at', 'updated_at'])
        .executeTakeFirst();
      if (!recipe) throw new Error('Recipe not found');
      return recipe;
    }),

    create: userProcedure
      .input(
        z.object({
          name: z.string().min(1),
          description: z.string().default(''),
          instructions: z.string().min(1),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        return getKnowledgeQb(['recipe'])
          .insertInto('recipe')
          .values({
            team_id: ctx.user.teamId as TeamId,
            name: input.name,
            description: input.description,
            instructions: input.instructions,
            created_by: ctx.user.id as UserId,
          })
          .returning(['id', 'name', 'description', 'instructions'])
          .executeTakeFirstOrThrow();
      }),

    update: userProcedure
      .input(
        z.object({
          id: z.string(),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          instructions: z.string().min(1).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const { id, ...data } = input;
        const values: Record<string, unknown> = { updated_at: new Date() };
        if (data.name !== undefined) values.name = data.name;
        if (data.description !== undefined) values.description = data.description;
        if (data.instructions !== undefined) values.instructions = data.instructions;

        return getKnowledgeQb(['recipe'])
          .updateTable('recipe')
          .set(values)
          .where('id', '=', id as RecipeId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .returning(['id', 'name', 'description', 'instructions'])
          .executeTakeFirstOrThrow();
      }),

    delete: userProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await getKnowledgeQb(['recipe'])
          .deleteFrom('recipe')
          .where('id', '=', input.id as RecipeId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .execute();
        return { success: true };
      }),
  });
};

export { recipeRouter };
