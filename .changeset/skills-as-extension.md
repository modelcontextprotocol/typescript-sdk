---
'@modelcontextprotocol/server': minor
---

`SkillsExtension` is now a server extension: serve it with `new McpServer(info, { extensions: [skills] })`. `SkillsExtension.attach(server)` still works and is deprecated; it will be removed in a later minor release. Passing two skills extensions to one server in `extensions` fails construction (a duplicate extension id).
