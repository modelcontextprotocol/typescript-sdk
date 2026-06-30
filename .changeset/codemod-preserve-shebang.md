---
'@modelcontextprotocol/codemod': patch
---

Preserve a leading `#!` shebang (and the blank lines after it) when migrating a file. Some transforms drop the shebang because it is leading trivia of the first import they rewrite; the codemod now captures it before transforms and restores it before saving, so CLI packages whose `bin` points at the migrated entry keep working.
