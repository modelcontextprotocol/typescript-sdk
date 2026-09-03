---
'@modelcontextprotocol/client': patch
---

`StdioClientTransport` now spawns with [`tinyexec`](https://github.com/tinylibs/tinyexec) instead
of `cross-spawn`, cutting six runtime dependencies down to one with no transitive deps. `tinyexec`
vendors cross-spawn's command normalization, so Windows `.cmd`/`.bat` handling is unchanged, and
its `process.env` merging and `node_modules/.bin` PATH injection are both disabled so the
{@linkcode getDefaultEnvironment} safelist and command resolution stay exactly as before.

No public API change.
