---
'@modelcontextprotocol/codemod': patch
---

Project-type inference no longer counts bare SDK paths that appear only in ordinary string data. The v1→v2 codemod's source scanner matched any quoted `@modelcontextprotocol/sdk/client|server` subpath anywhere in a file, so a server path stored as data (example text, a log message, a config value) misclassified a client-only project as `both` — rewriting shared type imports to `@modelcontextprotocol/server` and adding a server dependency the project never uses. The scanner now requires a module-specifier position: static imports and re-exports (`from '...'`), side-effect imports, dynamic `import('...')` (including webpack magic comments), `require('...')` / `require.resolve('...')`, and the `vi.`/`jest.` mock-method calls the mock-paths transform rewrites. Known limitation: the scan is lexical, so a string whose text embeds a complete import statement still counts.
