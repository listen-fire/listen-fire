// Every public module that adds a section to the handbook, by name: the
// sections a host assembles into its book (`system:<name>`), held to the
// handbook's own checks.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { AFFINITY_MANIFEST } from '../../../modules/affinity/manifest';
import { AIRTABLE_MANIFEST } from '../../../modules/airtable/manifest';
import { DEALROOM_MANIFEST } from '../../../modules/dealroom/manifest';
import { EVERTRACE_MANIFEST } from '../../../modules/evertrace/manifest';
import { FORMS_MANIFEST } from '../../../modules/forms/manifest';
import { GITHUB_MANIFEST } from '../../../modules/github/manifest';
import { GMAIL_MANIFEST } from '../../../modules/gmail/manifest';
import { MCP_MANIFEST } from '../../../modules/mcp/manifest';
import { SLACK_MANIFEST } from '../../../modules/slack/manifest';
import { STRIPE_MANIFEST } from '../../../modules/stripe/manifest';
import { SYSTEM_MANIFEST } from '../../../modules/system/manifest';
import { TELEGRAM_MANIFEST } from '../../../modules/telegram/manifest';
import { WEBHOOK_MANIFEST } from '../../../modules/webhook/manifest';
import { WHATSAPP_MANIFEST } from '../../../modules/whatsapp/manifest';

export const MODULES: Record<string, AdapterManifest> = {
  affinity: AFFINITY_MANIFEST,
  airtable: AIRTABLE_MANIFEST,
  dealroom: DEALROOM_MANIFEST,
  evertrace: EVERTRACE_MANIFEST,
  forms: FORMS_MANIFEST,
  github: GITHUB_MANIFEST,
  gmail: GMAIL_MANIFEST,
  mcp: MCP_MANIFEST,
  slack: SLACK_MANIFEST,
  stripe: STRIPE_MANIFEST,
  system: SYSTEM_MANIFEST,
  telegram: TELEGRAM_MANIFEST,
  webhook: WEBHOOK_MANIFEST,
  whatsapp: WHATSAPP_MANIFEST,
};

/** A fenced example in a section, its body without the fence lines. */
export const FENCE = /^```[^\n]*\n([\s\S]*?)^```$/gm;
