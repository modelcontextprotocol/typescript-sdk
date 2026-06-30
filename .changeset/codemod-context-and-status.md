---
'@modelcontextprotocol/codemod': patch
---

Two long-standing intervention classes now migrate mechanically. `.code` reads on values an `instanceof SdkHttpError` check proves — in the same condition or the guarded block — rewrite to `.status` (v2 carries the HTTP status there; `.code` is an `SdkErrorCode` string); unprovable reads keep the existing warning. The context-property remap reaches three shapes the call-site scan missed: functions assigned to `fallbackRequestHandler`, parameters annotated with a context type directly or via a same-file alias (accesses remap in place, the parameter keeps its name), and contexts forwarded wholesale to helpers, which get an advisory naming the callee.
