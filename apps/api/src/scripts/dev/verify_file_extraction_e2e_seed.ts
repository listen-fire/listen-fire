/**
 * Fixture setup for the runtime verification of the FILE extraction seam:
 * `extract from [ … .`File`]` over real Slack attachments.
 *
 * Seeds the fake Slack `general` channel (empty by default, so the probe reads
 * exactly these) with two messages, each carrying one synthetic PDF:
 *
 *   1. a BORN-DIGITAL one-pager — its text lives in the file's own text layer,
 *      so it is read with no OCR provider in the path at all;
 *   2. a page with NO text layer (the shape a scan has), which needs the OCR
 *      provider — and on a deployment without one the run must say so by name
 *      rather than report an empty source.
 *
 * Everything in both documents is invented (Acme Corp, Jane Doe): the tree is
 * mirrored to a public repository.
 *
 * Usage:
 *   pnpm dev:seed                      # the dev-loop team + its Slack credential
 *   ts-node … verify_file_extraction_e2e_seed.ts
 *   pnpm dev:movement provision --file src/scripts/dev/_fixtures/file_extraction_probe.mvt
 *   GOOGLE_PRIVATE_KEY= GOOGLE_CLIENT_EMAIL= GOOGLE_CLIENT_ID= GOOGLE_PROJECT_ID= \
 *     GOOGLE_PROJECT_LOCATION= GOOGLE_OCR_PROCESSOR_ID= GOOGLE_STORAGE_BUCKET_NAME= \
 *     pnpm dev:movement run file_extraction_probe
 *
 * (Blanking the GOOGLE_* variables is what reproduces a deployment with no OCR
 * provider — the case the second document is here to prove.)
 */
import './_profile_loader';

import { jsPDF } from 'jspdf';

import { ensureDevLoopTeam, ensureDevLoopSlackCredential } from './_lib';

const FAKE_BASE = process.env.FAKE_CHANNELS_URL ?? 'http://localhost:5556';
const CHANNEL = 'C001'; // `general` — no seeded messages, so the probe reads only ours

const READABLE_FILE_ID = 'F_ACME_ONEPAGER';
const UNREADABLE_FILE_ID = 'F_SCANNED_NOTES';

/** A born-digital PDF: the text rides the page's text layer. */
function textLayerPdf(lines: string[]): string {
  const doc = new jsPDF();
  lines.forEach((line, i) => doc.text(line, 10, 20 + i * 10));
  return Buffer.from(doc.output('arraybuffer')).toString('base64');
}

/** A PDF with a drawn box and no text at all — what a scan looks like to a
 *  text-layer reader, without needing a real scanned image in the repo. */
function noTextLayerPdf(): string {
  const doc = new jsPDF();
  doc.rect(20, 20, 120, 60);
  doc.rect(20, 100, 120, 40);
  return Buffer.from(doc.output('arraybuffer')).toString('base64');
}

/** A Slack file object as it rides a message in `conversations.history`. */
function fileOnMessage(id: string, name: string) {
  const url = `${FAKE_BASE}/slack/files/${id}/download`;
  return {
    id,
    name,
    title: name,
    mimetype: 'application/pdf',
    filetype: 'pdf',
    url_private: url,
    url_private_download: url,
  };
}

async function seedSlack(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const readableTs = `${now}.000100`;
  const unreadableTs = `${now + 1}.000200`;

  const entities = [
    {
      entity_type: 'file',
      id: READABLE_FILE_ID,
      data: {
        name: 'acme-onepager.pdf',
        title: 'Acme Corp one-pager',
        mimetype: 'application/pdf',
        content_base64: textLayerPdf([
          'Acme Corp — Series A one-pager',
          'Acme Corp is raising a $5M Series A led by Example Ventures.',
          'Revenue is $1.2M ARR, growing 20% month over month.',
          'Jane Doe is the founder and chief executive.',
          'The company sells scheduling software to logistics operators.',
        ]),
      },
    },
    {
      entity_type: 'file',
      id: UNREADABLE_FILE_ID,
      data: {
        name: 'scanned-notes.pdf',
        title: 'Scanned notes',
        mimetype: 'application/pdf',
        content_base64: noTextLayerPdf(),
      },
    },
    {
      entity_type: 'message',
      id: readableTs,
      data: {
        channel: CHANNEL,
        ts: readableTs,
        user: 'U001',
        text: 'One-pager attached.',
        files: [fileOnMessage(READABLE_FILE_ID, 'acme-onepager.pdf')],
      },
    },
    {
      entity_type: 'message',
      id: unreadableTs,
      data: {
        channel: CHANNEL,
        ts: unreadableTs,
        user: 'U002',
        text: 'Scan of the meeting notes.',
        files: [fileOnMessage(UNREADABLE_FILE_ID, 'scanned-notes.pdf')],
      },
    },
  ];

  const res = await fetch(`${FAKE_BASE}/admin/slack/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entities }),
  });
  if (!res.ok) {
    throw new Error(`admin/slack/seed failed: ${res.status} ${await res.text()}`);
  }
  console.log(`  Seeded 2 messages on ${CHANNEL} (${readableTs}, ${unreadableTs})`);
}

async function main(): Promise<void> {
  const seed = await ensureDevLoopTeam();
  await ensureDevLoopSlackCredential(seed.teamId);
  console.log(`  Dev Loop team ${seed.teamId} has its Slack credential`);
  await seedSlack();
  console.log('\nNext: provision + run src/scripts/dev/_fixtures/file_extraction_probe.mvt');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
