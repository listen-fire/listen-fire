# @listen-fire/google-drive

## 0.12.7

### Patch Changes

- e104750: Google Drive can copy a file. Write a file along both its destination folder's `Files` edge and the source file's `Copies` edge: `write (folder-[:Files]->, template-[:Copies]->) { Name: "Acme brief" }`. `Name` is optional (Drive names the copy otherwise). The copy is an ordinary file afterwards, so a later write can name it as a parent. The source must be a file the connection was granted (picked, or created by the connection); Drive's refusal is reported as "not granted".

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
