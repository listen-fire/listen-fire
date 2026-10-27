---
"@listen-fire/engine": patch
---

The checker compares every value handed to a plugin with the type the plugin declares for it, by position, in a settings record and in a `through` stage alike. A plain value of another type (`fetchUrl(5)`, `jev.score(x, 5)`, a text where a list is taken), which passed silently, is now a `MOV_CALL_ARG_TYPE` warning. It stays a warning for every 0.12 pin, since those releases admitted it and a plugin may have coerced it; refusing it waits for the next compatibility key (0.13). A text written in place against a plugin's option set is judged as that option: one naming no option is refused with `MOV_ENUM_UNKNOWN_VALUE`, as it already is for a function's parameter.
