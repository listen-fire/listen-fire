# Google OAuth Security Posture — CASA Tier 2 Readiness

Last updated: 2026-03-23

## Scope

This document covers the security controls for Google OAuth integrations (Gmail, Google Drive) as required for Google's CASA Tier 2 assessment and the Google API Services User Data Policy.

## Token & Credential Storage

- **Encryption at rest**: AES-256-GCM with HKDF-SHA256 key derivation. Each credential row uses its own derived encryption key (DEK) from a master key via HKDF with the credential ID as context.
- **Master key**: Stored as `ENCRYPTION_MASTER_KEY` environment variable, base64-encoded.
- **Database**: Encrypted credentials stored as `bytea` in `external_service_credentials.credentials`. Team-scoped via `team_id` foreign key.
- **No client-side credential storage**: OAuth tokens never reach the browser. Callback pages receive a single-use claim token (random nonce, 15-minute TTL, encrypted in server memory). The claim token is exchanged for a persisted credential when the user saves.

### Key Rotation Strategy

Encryption uses HKDF with per-credential context derivation, meaning each credential has a unique DEK even under the same master key. Key rotation plan:

1. Add a `key_version` column to `external_service_credentials`
2. New credentials use the current key version
3. On token refresh (which already re-encrypts), migrate to latest key version
4. Background job to re-encrypt remaining credentials on key rotation

Not yet implemented — current risk is mitigated by per-credential key derivation ensuring a single compromise doesn't expose all credentials without the per-row context.

## OAuth Flow Security

- **PKCE**: Code challenge (S256) + code verifier on all OAuth flows
- **State validation**: Random state parameter verified server-side, expires after 15 minutes
- **Scope minimization**: `gmail.readonly` only (Gmail), `drive.readonly` (Google Drive)
- **Token revocation**: On credential deletion, Google's revocation endpoint is called (`oauth2Client.revokeToken`) before local deletion. Best-effort — local deletion proceeds even if revocation fails.

## Access Controls

- All credential queries are scoped by `team_id` — a user can only access credentials belonging to their team
- Credential lookup by ID always includes a `team_id` filter, preventing cross-team access even with a known credential ID
- CASL authorization layer enforces permission checks at the application level

## Data Handling

### What data is accessed

- **Gmail**: Email metadata (from, to, cc, bcc, subject, date) and body text via `gmail.readonly` scope
- Email content is stored as plaintext in `inbound_payload.content` for processing and provenance display

### Retention policy

Email data is retained for the lifetime of the user's account or until the user requests deletion. Rationale: raw payloads serve as visible provenance for extracted knowledge — users need to trace how structured data was derived from source messages.

### User data deletion

- Users can disconnect an integration via the `deleteCredential` endpoint, which:
  1. Revokes the Google OAuth token at Google's endpoint
  2. Clears any cached API clients
  3. Deletes the credential row from the database
- Bulk deletion of ingested email data: available on request. Contact support to initiate a data wipe for a specific integration.

### Limited Use compliance

- Email data is used solely for the purposes described in the app's consent screen (knowledge extraction and pipeline processing)
- Email data is not transferred to third parties
- Email data is not used for advertising
- Email data is not read by humans unless: the user views it in the app UI, or it is required for security/legal compliance

## Content Security

- Email HTML content is sanitized with DOMPurify before rendering
- Email preview uses a sandboxed iframe (`sandbox="allow-same-origin"`, no `allow-scripts`)
- No `dangerouslySetInnerHTML` on user-generated or email-sourced content

## Transport Security

- HTTPS enforced in production via `secure: true` on auth cookies
- All Google API communication uses the `google-auth-library` SDK which enforces HTTPS
- No hardcoded HTTP URLs in production paths

## Error Handling

- OAuth tokens are never logged. Error paths log descriptive messages without token values.
- Credential decryption failures are logged with credential ID only (no token content) and trigger a Slack support notification.

## CSRF Protection

- All OAuth flows use state parameter validation with 15-minute expiry
- PKCE (S256) on all flows that support it
- State cache is single-use (deleted after validation)
