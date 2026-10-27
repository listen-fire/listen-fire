# @listen-fire/jev

[Jev](https://typesafe.ai), Typesafe AI's non-generative judge, as two cheap classifier plugins (`@lf/jev`, bundled with `lf`). Jev answers a question with a probability instead of writing text: about half a second a call, at $0.042 per million input tokens.

```
import { `@lf/jev` as jev } from plugins

wanted = jev.score(m.Body, "Is this email asking us to meet or to buy something?")
kind   = jev.classify({ subject: m.Subject, body: m.Body }, ["introduction", "sales pitch", "support request", "other"], "What kind of email is this?")
```

- `jev.score(subject, question)` answers `{ probability }`, from 0 to 1 (a Jev `noul` question).
- `jev.classify(subject, labels, question)` answers `{ label, confidence }`: one of the labels given, and how likely it is right (a Jev `choice` question; each label is an option's description).
- `subject` is a text, or a record of the fields that matter, sent with its empty fields left out (as the platform's entity judge sends a record).

Both answer a record, not a bare number: a plugin's plain value reaches the program as text, so a record is what keeps `probability` a number.

## Setting it up

```
lf connect @lf/jev
lf credential add --module @lf/jev typesafe   # the API key, and an address only for another Jev
```

## Cost, limits and failures

- Each call answers what it cost (Jev's count of input tokens at $0.042 a million, rounded up to a whole microdollar, never zero), which counts against the run's cost cap like a model call. A call is not started once the run has spent its cap.
- A request over about 30,000 tokens (measured at a token per three bytes, which overcounts English) fails before it is sent, saying how large it was. Jev itself accepts about 31.7k and refuses about 39k.
- A refused key (401, 403) fails the run, naming the credential; no key at all fails naming the command that adds one. A rate limit or overload (429, 529) is retried with a growing, jittered delay, three tries in all, as the platform's client does; any other refusal fails at once.

The handbook section (`JEV_HANDBOOK_SECTION`, for a host to add as the `plugin:jev` chapter) says when to reach for Jev rather than `ai(…)` or `extract`.
