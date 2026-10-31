---
"@listen-fire/module-kit": patch
---

An adapter module's manifest may declare `resendWindowSeconds`, how long its provider may re-send an arrival it already sent; module-kit states it on the wire. A module's references and entry points may declare how a listen reads them (`delivery`, `pollEverySeconds`, `bounded`, `boundedBy`, `carries`, `attributes`, `cheapToList`, `parentChanges`, `relistEverySeconds`; an entry point also `listenable`, `cursor`, `identity`, `version`), and a field may be of kind `owned`. A 0.13 `listen-fire` and `introspectAdapter` refuse a declaration that cannot mean what it says, naming it.
