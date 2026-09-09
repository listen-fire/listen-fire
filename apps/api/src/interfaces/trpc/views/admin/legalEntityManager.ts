import { z } from 'zod';

import { getQb, jsonbAgg, getValuationsQb } from '../../../../lib/kysely';
import { trpc } from '../../trpc';
import { currentContext } from '../../../../services/context';
import { ensureAdmin } from '../../../../lib/utils/admin';
import { openAiChatStructured } from '../../../../lib/openai';
import { TeamId } from '../../../../generated/kysely/core/Team';
import { LegalEntityId } from '../../../../generated/kysely/valuations/LegalEntity';

const legalEntityManagerRouter = (procedure: typeof trpc.procedure) => {
  return trpc.router({
    // Every-team read, on purpose: this feeds the platform admin's team picker.
    // The router is mounted on `platformAdminProcedure`, which is what makes it
    // legitimate — the ability never narrowed it either, since a platform admin
    // is granted MANAGE on everything.
    getTeams: procedure.query(async () => {
      const ctx = currentContext();
      const teams = await ctx.prisma.team.findMany({
        select: {
          id: true,
          name: true,
        },
        orderBy: {
          name: 'asc',
        },
      });

      return teams;
    }),

    getLegalEntitiesWithJargon: procedure
      .input(
        z.object({
          teamId: z.string(),
          page: z.number().min(1).default(1),
          limit: z.number().min(1).max(100).default(50),
        }),
      )
      .query(async ({ input: { teamId, page, limit } }) => {
        const qb = getValuationsQb(['legal_entity', 'investment']);

        // Legal jargon patterns to search for
        const legalJargonPatterns = [
          'LLC',
          'LP',
          'SA',
          'Ltd',
          'Limited',
          'Inc',
          'Corp',
          'Corporation',
          'GmbH',
          'AG',
          'SAS',
          'SARL',
          'BV',
          'NV',
          'AB',
          'AS',
          'Oy',
          'SpA',
          'SRL',
          'Ltda',
          'Pty',
          'PLC',
          'LLP',
          'PLLC',
        ];

        // Build the base query with joins and filters
        const baseQuery = qb
          .selectFrom('legal_entity as le')
          .innerJoin('investment as inv', 'inv.investor_profile_id', 'le.id')
          .innerJoin('legal_entity as company', 'company.id', 'inv.investment_profile_id')
          .where('le.team_id', '=', teamId as TeamId)
          .where((eb) =>
            eb.or(legalJargonPatterns.map((pattern) => eb('le.name', 'ilike', `%${pattern}%`))),
          )
          .groupBy('le.id')
          .having((eb) => eb.fn.count('inv.id'), '>', 0);

        const [entities, totalCount] = await Promise.all([
          baseQuery
            .select(($) => [
              'le.id',
              'le.name',
              'le.slug',
              'le.type',
              'le.description',
              'le.personal_website as personalWebsite',
              'le.created_at as createdAt',
              jsonbAgg($, {
                id: 'company.id',
                name: 'company.name',
                slug: 'company.slug',
                personalWebsite: 'company.personal_website',
              })
                .distinct()
                .as('investments'),
            ])

            .groupBy('le.id')
            .orderBy('le.name', 'asc')
            .limit(limit)
            .offset((page - 1) * limit)
            .execute(),
          baseQuery
            .select((eb) => eb.fn.count('le.id').as('count'))
            .execute()
            .then((result) => Number(result?.length || 0)),
        ]);

        const totalPages = Math.ceil(totalCount / limit);

        return {
          entities: entities,
          pagination: {
            page,
            limit,
            totalCount,
            totalPages,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1,
          },
        };
      }),

    getPotentialMatches: procedure
      .input(
        z.object({
          entityId: z.string(),
          teamId: z.string(),
        }),
      )
      .query(async ({ input: { entityId, teamId } }) => {
        const ctx = currentContext();
        await ensureAdmin(ctx);
        // Get the selected entity

        const selectedEntity = await ctx.prisma.legalEntity.findUnique({
          where: { id: entityId, teamId: teamId },
          select: { name: true, legalName: true, teamId: true },
        });

        if (!selectedEntity) {
          throw new Error('Entity not found');
        }
        const variants = await getNameVariants(selectedEntity?.name || '');

        // Find potential matches
        const matches = await getValuationsQb(['legal_entity', 'investment'])
          .selectFrom('legal_entity as le')
          .leftJoin('investment as inv', 'inv.investor_profile_id', 'le.id')
          .leftJoin('legal_entity as company', 'company.id', 'inv.investment_profile_id')
          .select(($) => [
            'le.id',
            'le.name',
            'le.slug',
            'le.type',
            'le.description',
            'le.created_at as createdAt',
            jsonbAgg($, {
              id: 'company.id',
              name: 'company.name',
              slug: 'company.slug',
              personalWebsite: 'company.personal_website',
            })
              .distinct()
              .as('investments'),
          ])

          .where((eb) => eb.or(variants.map((pattern) => eb('le.name', 'ilike', `%${pattern}%`))))
          .where('le.team_id', '=', teamId as TeamId)
          .where('le.id', '!=', entityId as LegalEntityId)
          .groupBy('le.id')
          .orderBy('le.name', 'asc')
          .execute();

        return {
          selectedEntity,
          potentialMatches: matches,
        };
      }),

    updateEntity: procedure
      .input(
        z.object({
          entityId: z.string(),
          teamId: z.string(),
          name: z.string().min(1, 'Name is required'),
          type: z.enum(['COMPANY', 'FUND', 'NATURAL_PERSON', 'SPV']).optional(),
          personalWebsite: z.string().url('Must be a valid URL').optional().or(z.literal('')),
        }),
      )
      .mutation(async ({ input: { entityId, teamId, name, type, personalWebsite } }) => {
        const ctx = currentContext();
        await ensureAdmin(ctx);
        // Verify the entity belongs to the team
        const entity = await ctx.prisma.legalEntity.findFirst({
          where: {
            id: entityId,
            teamId: teamId,
          },
        });

        if (!entity) {
          throw new Error('Entity not found or access denied');
        }

        // Update the entity
        const updatedEntity = await ctx.prisma.legalEntity.update({
          where: { id: entityId },
          data: {
            name,
            type: type || null,
            personalWebsite: personalWebsite || null,
          },
          select: {
            id: true,
            name: true,
            type: true,
            personalWebsite: true,
          },
        });

        return updatedEntity;
      }),
  });
};

async function getNameVariants(entityName: string): Promise<string[]> {
  const response = await openAiChatStructured(
    [
      {
        role: 'system',
        content: `Given the an entity name , generate a list of variations that could be used to refer to the entity in an informal or colloquial context. 
        Avoid variations that are too generic or unrelated to the entity's name. Try variations without the numbering, such as "II" or "2", and focus on the core name.

        EXAMPLE: 
        For the entity name "468 Capital II GmbH & Co. KG", you might return variations like:
          "468 Capital II",
          "468 Capital 2",
          "468 Capital",
          "468 Cap II",
          "468 Cap 2",
          "468 Cap",
          "468 KG",
          "468 Capital KG",
          "468 II KG",
          "468 Capital II KG",
          "468 Capital II GmbH",
          "468CapitalII",
          "468Cap2",

        CRITICAL: Return the results as a JSON object the following structure:
        {
          "variations": [
            "Variation 1",
            "Variation 2",
            "Variation 3",
            ...
          ]
        }`,
      },
      { role: 'user', content: entityName },
    ],
    { model: 'gpt-5-mini' },
  );

  // Parse the JSON array from OpenAI's response
  return JSON.parse(response).variations || [];
}

export { legalEntityManagerRouter };
