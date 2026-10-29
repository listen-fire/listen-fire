# @listen-fire/files-s3

## 0.12.7

### Patch Changes

- bb39a27: An upload whose source stream fails part-way now fails with the source's error, where before the PUT waited forever for the rest of its declared length. The body is built with `stream.pipeline`, and its error aborts the send.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
