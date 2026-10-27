---
"@listen-fire/fake-channels": patch
---

The fake Gmail keeps a binary attachment byte for byte: a seeded attachment may carry `contentBase64` (beside `content` for text), and a sent message's attachments are kept as their decoded bytes. The fake Drive splits a multipart upload as bytes, keeps them exactly (`contentBase64`), answers `size`, `md5Checksum` and `sha256Checksum`, and serves the exact bytes on `alt=media`; a copy carries the source's bytes and checksums.
