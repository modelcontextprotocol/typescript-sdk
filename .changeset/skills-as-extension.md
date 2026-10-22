---
'@modelcontextprotocol/server': minor
---

`SkillsExtension` is now a server extension: serve it with `new McpServer(info, { extensions: [skills] })`. This removes the experimental `SkillsExtension.attach(server)`; replace `skills.attach(server)` with the `extensions` option. Passing two skills extensions to one server now fails construction (a duplicate extension id) instead of throwing from the second `attach`.
