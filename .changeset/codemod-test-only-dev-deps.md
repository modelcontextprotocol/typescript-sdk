---
'@modelcontextprotocol/codemod': patch
---

The v1-to-v2 codemod now adds a v2 package to `devDependencies` when only test files import it, instead of putting it next to the v1 SDK in `dependencies`. Packages any non-test file imports still go where the v1 SDK was declared. Test files are recognized the same way as for the injected `zod` dependency, relative to the manifest that receives the package.
