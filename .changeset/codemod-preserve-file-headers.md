---
'@modelcontextprotocol/codemod': patch
---

Preserve file-leading shebangs and banner comments when import rewrites remove the first
import declaration in a file. Previously the attached leading trivia was silently deleted.
