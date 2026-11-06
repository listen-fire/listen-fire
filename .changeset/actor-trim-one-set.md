---
"@listen-fire/engine-contracts": patch
---

`normalisedActor` trims one named set of characters, the same one `lf` trims, so an address with a byte order mark or a next line character reads the same in both. JavaScript's `trim` alone stripped U+FEFF, and Rust's alone stripped U+0085.
