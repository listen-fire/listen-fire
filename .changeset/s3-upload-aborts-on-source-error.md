---
"@listen-fire/files-s3": patch
---

An upload whose source stream fails part-way now fails with the source's error, where before the PUT waited forever for the rest of its declared length. The body is built with `stream.pipeline`, and its error aborts the send.
