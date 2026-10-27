---
"@listen-fire/engine": patch
---

A plugin's plain value reaches the program in the type the plugin declares: a number as a number, a boolean as a boolean, a list as a list, answered under `data.value` (a text output may still answer its text). Before, every value but a file arrived as text. A text that spells a declared number or boolean (`"0.8"`, `"true"`) is read as one. Any other value outside the declared type is bound as the 0.12 releases bound it (its text, or a file output's `data.value`) and the run carries a `MOVENG_PLUGIN_WARNING` naming the plugin and what it handed back; failing the call waits for the next compatibility key (0.13).
