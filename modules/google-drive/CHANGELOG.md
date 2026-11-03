# @listen-fire/google-drive

## 0.12.10

### Patch Changes

- Updated dependencies [5bc85fb]
  - @listen-fire/google-sheets@0.13.0

## 0.12.9

### Patch Changes

- Updated dependencies [4516899]
- Updated dependencies [4bb86df]
- Updated dependencies [c7004f6]
  - @listen-fire/module-kit@0.14.0

## 0.12.8

### Patch Changes

- Updated dependencies [4c09d6a]
- Updated dependencies [faa7050]
- Updated dependencies [acec0bd]
- Updated dependencies [301dab3]
- Updated dependencies [3c2774e]
- Updated dependencies [dd81bed]
- Updated dependencies [c4af6cc]
- Updated dependencies [a942076]
- Updated dependencies [46efd84]
- Updated dependencies [9520af9]
- Updated dependencies [9e9316c]
- Updated dependencies [5bfc3f2]
- Updated dependencies [66d32d5]
- Updated dependencies [16e3776]
- Updated dependencies [16e3776]
- Updated dependencies [da1a05b]
- Updated dependencies [abc777e]
- Updated dependencies [ad23b9c]
  - @listen-fire/module-kit@0.13.0

## 0.12.7

### Patch Changes

- e104750: Google Drive can copy a file. Write a file along both its destination folder's `Files` edge and the source file's `Copies` edge: `write (folder-[:Files]->, template-[:Copies]->) { Name: "Acme brief" }`. `Name` is optional (Drive names the copy otherwise). The copy is an ordinary file afterwards, so a later write can name it as a parent. The source must be a file the connection was granted (picked, or created by the connection); Drive's refusal is reported as "not granted".

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
