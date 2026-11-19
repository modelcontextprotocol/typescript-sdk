---
'@modelcontextprotocol/client': patch
---

`StdioClientTransport` no longer lets an inherited `PATH` shadow an explicit `Path` in `env` on Windows, where environment variable lookup is case-insensitive: the caller's entry now wins regardless of casing, and POSIX behavior is unchanged.
