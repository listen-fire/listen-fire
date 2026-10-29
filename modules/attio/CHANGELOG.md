# @listen-fire/attio

## 0.12.7

### Patch Changes

- 89f92c1: A 429 from Attio is retried after the `Retry-After` it asked for (seconds or an HTTP date), or after an exponential backoff when it sent none, instead of a fixed extra 30 seconds. Attio now sends through module-kit's `retryingFetch`, as `@lf/mcp` does.

## 0.12.6

### Patch Changes

- Core imports are peers; first release under per-package versions.

## 0.12.5 and earlier: see the language's CHANGELOG.md at the repository root
