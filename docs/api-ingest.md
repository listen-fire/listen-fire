# Listen-Fire Ingest API

Submit deals programmatically via the Listen-Fire API.

## Authentication

All requests require an API key in the `Authorization` header:

```
Authorization: Bearer lf_xxxxxxxxxxxxxxxx
```

## Endpoints

### POST /api/v1/ingest

Submit a deal to the pipeline.

**Request Body:**

```json
{
  "title": "Acme Inc - Series A",
  "content": "Optional text content or notes about the deal...",
  "links": [
    { "url": "https://acme.com" },
    { "url": "https://linkedin.com/company/acme" }
  ],
  "attachments": [
    {
      "key": "pitch-deck.pdf",
      "filename": "pitch-deck.pdf",
      "documentId": "886c3bc8-ce6e-402e-899f-f5c4e3a7edea",
      "size": 1024000
    }
  ],
  "contentType": "DEALFLOW"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Title for the submission |
| `content` | string | No | Text content or notes |
| `links` | array | No | URLs to scrape (company website, LinkedIn, etc.) |
| `attachments` | array | No | Documents uploaded via `/api/v1/documents` |
| `contentType` | string | No | One of: `DEALFLOW`, `INVESTOR_UPDATE`, `REQUEST`, `UNKNOWN`, `COMPANY_INFO`. Defaults to `DEALFLOW` |

**Response:**

```json
{
  "success": true,
  "payloadId": "payload_xyz789"
}
```

This indicates that

---

### POST /api/v1/documents

Upload a document to attach to a deal submission.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | MIME type (e.g., `application/pdf`) |
| `Content-Length` | Yes | File size in bytes |
| `X-Filename` | No | Filename (or use `?filename=` query param) |

**Request Body:** Raw file bytes

**Response:**

```json
{
  "key": "doc_abc123",
  "filename": "pitch-deck.pdf",
  "documentId": "doc_abc123",
  "size": 1024000
}
```

The response can be directly added to the `attachments` array in the ingest request.

---

## Example: Submit a deal with attachments

```bash
# 1. Upload the pitch deck
ATTACHMENT=$(curl -s -X POST "https://api.example.com/api/v1/documents" \
  -H "Authorization: Bearer lf_xxxxxxxx" \
  -H "Content-Type: application/pdf" \
  -H "X-Filename: pitch-deck.pdf" \
  --data-binary @pitch-deck.pdf)

# 2. Submit the deal with the attachment
curl -X POST "https://api.example.com/api/v1/ingest" \
  -H "Authorization: Bearer lf_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Acme Inc - Series A\",
    \"content\": \"Intro from John at Sequoia. Fintech company building B2B payments.\",
    \"links\": [
      { \"url\": \"https://acme.com\" }
    ],
    \"attachments\": [$ATTACHMENT]
  }"
```

## Example: Simple text submission

```bash
curl -X POST "https://api.example.com/api/v1/ingest" \
  -H "Authorization: Bearer lf_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Quick note - Acme Inc",
    "content": "Met the founders at a conference. Building in the AI space. Worth following up."
  }'
```

## Example: URL-only submission

```bash
curl -X POST "https://api.example.com/api/v1/ingest" \
  -H "Authorization: Bearer lf_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Acme Inc",
    "links": [
      { "url": "https://acme.com" },
      { "url": "https://linkedin.com/company/acme" }
    ]
  }'
```
