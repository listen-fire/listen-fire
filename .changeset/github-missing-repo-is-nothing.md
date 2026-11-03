---
"@listen-fire/github": patch
---

A `Repositories` walk whose WHERE pins `Full Name` to a repository GitHub does not know (404) now answers nothing, as any filter that matches nothing does, so `only(...)` is null and the program's own check runs. Before, the run failed with GitHub's 404 error.
