# @listen-fire/file-text

## 0.12.7

### Patch Changes

- Reads an image (png, jpeg, gif, tiff, bmp, webp; by content type or extension) through a new optional `ocrImage` dependency, the list the ocr slot's contract and the standalone runner read. A shell that passes none keeps answering `unsupported_type`. An image with no text is `no_text`; a failed read is `extraction_failed`, saying it went to OCR. `isRefusal` now also holds while a file is read, not only while its bytes are opened, so a run past its budget is refused rather than reading as an unreadable file.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
