---
'@modelcontextprotocol/server': minor
---

`SkillsExtension` is now a server extension: serve it with `new McpServer(info, { extensions: [skills] })`. `SkillsExtension.attach(server)` still works and is deprecated; it will be removed in a later minor release. Passing two skills extensions to one server in `extensions` fails construction (a duplicate extension id). With `extensions`, the skills resource template is registered at construction, so a `ResourceTemplate` the application registers for `skill://` URIs comes after it; a fixed-URI resource still wins at its URI.
