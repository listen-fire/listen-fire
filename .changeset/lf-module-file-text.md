---
"@listen-fire/engine": patch
---

`lf` reads a file a module owns (a Gmail attachment, a Drive file) for an extraction or `File.read`: it fetches the bytes through the owning module's `resolveFileRef`, as a write that files the same attachment elsewhere already did, then reads the PDF's text layer (or asks the ocr slot) as for a stored file. Before, the run warned `MOVENG_FILE_BYTES_UNAVAILABLE` ("a file 'gmail' owns is not read by lf yet") and the extraction saw nothing.
