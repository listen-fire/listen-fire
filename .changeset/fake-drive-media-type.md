---
"@listen-fire/fake-channels": patch
---

The fake Drive takes an upload's type from its media part when the metadata names none, as real Drive does, so a PDF the Google Drive module uploads stays `application/pdf` rather than `application/octet-stream`.
