---
'@modelcontextprotocol/core': patch
---

Fix UTF-8 corruption in `ReadBuffer` when multi-byte sequences (em-dash, emoji) split across stdio chunk boundaries. `Buffer.toString('utf8', ...)` decodes slices eagerly and produces replacement characters when a multi-byte sequence is split between chunks. Replaced with `TextDecoder` in streaming mode, which carries partial bytes forward until the sequence completes. `TextDecoder` is a Web Standards API and remains compatible with Cloudflare Workers, Deno, and Bun.
