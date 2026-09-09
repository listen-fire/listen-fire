/**
 * Generate a JWT auth token for the test harness UI.
 *
 * Usage (from apps/api):
 *   npx tsx scripts/generate-test-token.ts <email>
 *
 * Reads TOKEN_SECRET and SESSION_JWT_AUDIENCE (legacy name: AUTH0_AUDIENCE)
 * from your .env automatically
 * if you use dotenv or have them exported.
 */

import 'dotenv/config';
import { sign } from 'jsonwebtoken';

const email = process.argv[2];
if (!email) {
  console.error('Usage: npx tsx scripts/generate-test-token.ts <email>');
  process.exit(1);
}

const TOKEN_SECRET = process.env.TOKEN_SECRET;
const AUDIENCE = process.env.SESSION_JWT_AUDIENCE ?? process.env.AUTH0_AUDIENCE;

if (!TOKEN_SECRET || !AUDIENCE) {
  console.error('Missing TOKEN_SECRET or SESSION_JWT_AUDIENCE environment variables.');
  process.exit(1);
}

const token = sign(
  { 'listen-fire-token/email': email },
  TOKEN_SECRET,
  {
    algorithm: 'HS256',
    expiresIn: '180d',
    audience: AUDIENCE,
  },
);

console.log('\nGenerated token for:', email);
console.log('\n' + token + '\n');
