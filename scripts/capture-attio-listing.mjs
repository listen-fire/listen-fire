// Captures the Attio app-listing images from /marketing/attio-listing/[slide].
//
// Attio requires 2960×1848 PNG (16:10, no transparency, square corners) —
// slides render at 1480×924 CSS px and are captured at deviceScaleFactor 2.
//
// Usage: node scripts/capture-attio-listing.mjs [outDir]
//   BASE_URL=http://localhost:3003 by default (the running web dev server).

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "apps/api/package.json"));
const { chromium } = require("playwright");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3003";
const OUT_DIR = process.argv[2] ?? "/tmp/attio-listing";
const SLIDE_COUNT = 5;
const WIDTH = 1480;
const HEIGHT = 924;

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
});

for (let i = 1; i <= SLIDE_COUNT; i++) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/marketing/attio-listing/${i}`, {
    waitUntil: "networkidle",
  });
  // The Next.js dev-tools indicator renders inside the clip region.
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const out = path.join(OUT_DIR, `slide-${i}.png`);
  await page.screenshot({
    path: out,
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
  });
  console.log(`captured ${out} (2960×1848)`);
  await page.close();
}

await browser.close();
