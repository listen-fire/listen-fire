# @listen-fire/jev

## 0.12.8

### Patch Changes

- 6d7a585: A new module, `@lf/jev`: Jev, Typesafe AI's non-generative judge, as two cheap classifier plugins. `jev.score(subject, question)` answers a number from 0 to 1, how likely a statement is true (`if (jev.score(m.Body, "…") >= 0.7)`); `jev.classify(subject, labels, question)` answers `{ label, confidence }`, which of the labels fits. The subject is a text or a record of the fields that matter. Each call answers what it cost (Jev's input tokens at $0.042 a million), counted against the run's cost cap; a request over about 30,000 tokens fails before it is sent; a refused key fails the run naming the credential, and a rate limit or overload is retried three times. The credential is an API key and, optionally, another Jev's address. This is the package's first release: `changeset version` takes it from 0.12.7 to 0.12.8.
