---
"@listen-fire/engine": patch
---

A plugin's plain value reaches the program in the type the plugin declares: a number as a number, a boolean as a boolean, a list as a list, answered under `data.value` (a text output may still answer its text). Before, every value but a file arrived as text. A value that does not fit the declared type fails the call, naming the plugin and what it handed back.
