---
"@listen-fire/engine": patch
---

A hop whose WHERE pins a type's discriminant with a literal (`` `listName` == "Master Deals List" `` on an Affinity record's `List Entries`) lands on the member that value picks, taken from the write shape's `discriminated` variants the catalog already carries. The checker types the hop's body and the WHERE's other conjuncts by that member, and the engine drops a landed record of another member before reading its fields. A host's own narrowing (`refinements` / `selectedMembers`) answers first, as before.
