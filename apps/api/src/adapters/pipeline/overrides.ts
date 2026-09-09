import { z } from 'zod';

const overridesSchema = z.object({
  email: z.string().optional(),
  emailMessageId: z.string().optional(),
  phoneNumber: z.string().optional(),
  title: z.string().optional(),
  password: z.string().optional(),
  slackMessageId: z.string().optional(),
  haveAlreadySeenThread: z.boolean().optional(),
});

type Overrides = z.infer<typeof overridesSchema>;

export { overridesSchema, Overrides };
