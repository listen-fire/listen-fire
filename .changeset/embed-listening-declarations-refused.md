---
"@listen-fire/embed": patch
---

An embedder's catalog build refuses, in an error that names it, a module whose references or entry points declare how a listen reads them in a way that cannot mean what it says (an unknown `delivery`, a polled edge without `pollEverySeconds`, `bounded: false` without `boundedBy`, a `carries` hop that is not there, a `membersChange` that is neither `"pushed"` nor `{ relistEverySeconds }`), and a field of kind `owned` that names no scalar. Such a module used to build a catalog; now `introspectAdapter` throws.
