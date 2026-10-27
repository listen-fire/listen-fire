---
"@listen-fire/engine": patch
---

The checker holds every value handed to a plugin to the type the plugin declares for it. A plain value of the wrong type (`fetchUrl(5)`, `jev.score(x, 5)`, a text where a list is taken) was admitted, and failed or misbehaved at run; it is now refused with `MOV_CALL_ARG_TYPE`, by position and in a settings record alike. A text written in place against a plugin's option set is judged as that option (`MOV_ENUM_UNKNOWN_VALUE` with a suggestion when it is none of them).
