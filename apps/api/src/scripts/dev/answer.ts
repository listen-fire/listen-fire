/**
 * Dev-loop CLI for answering a parked ask (asks-as-adapter). The minimal
 * internal injection path for verifying write-ask → answer → resume → complete
 * end-to-end; the real link / Slack / MCP front doors converge on the SAME
 * answer door this calls.
 *
 *   pnpm dev:answer <askId> <value>     # record an answer to an open ask
 *   pnpm dev:answer --list              # list open + answered asks (with family + state)
 *
 * <value> is parsed leniently: `true`/`false` → boolean, a numeric string →
 * number, a JSON object/array → its parsed shape, anything else → the raw
 * string. The answer door validates it against the ask's family and flips the
 * record `answered`; the await-resume worker (running in the dev-loop stack)
 * then drives any run waiting on the ask's Response forward.
 */

import './_profile_loader';

import { getAsksQb, getQb } from '../../lib/kysely';
import type { AskId } from '../../generated/kysely/asks/Ask';
import { answerAsk } from '../../services/translation_graph/adapters/ask/store';

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

async function listAsks(): Promise<void> {
  const rows = await getAsksQb(['ask'])
    .selectFrom('ask')
    .where('state', 'in', ['open', 'answered'])
    .select(['id', 'team_id', 'family', 'prompt', 'state', 'answer'])
    .orderBy('created_at', 'desc')
    .execute();
  console.log(JSON.stringify(rows, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--list' || args.length === 0) {
    await listAsks();
    return;
  }
  const askId = args[0];
  if (args[1] === undefined) {
    console.error('Usage: pnpm dev:answer <askId> <value>   |   pnpm dev:answer --list');
    process.exit(1);
  }
  const value = parseValue(args[1]);
  const outcome = await answerAsk({ id: askId as unknown as AskId, raw: value });
  console.log(JSON.stringify({ outcome }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
