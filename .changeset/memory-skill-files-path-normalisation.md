---
'@modelcontextprotocol/server': patch
---

`memorySkillFiles.list()` and `memorySkillFiles.read()` normalise the path they are given the same way the record index normalises its keys, so `list('sub/')`, `list('./sub')` and `read('./SKILL.md')` resolve instead of reporting a missing directory or file, and a `..` segment is rejected before it can reach the record.
