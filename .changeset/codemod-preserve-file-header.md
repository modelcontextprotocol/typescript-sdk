---
'@modelcontextprotocol/codemod': patch
---

Keep a file's leading comment block in place when `v1-to-v2` rewrites its imports. A rewritten import was inserted against the full start of the declaration it replaced — before that declaration's leading trivia — so a license/SPDX header stopped being the first thing in the file and the blank line separating it from the code was consumed, leaving the header attached to the next declaration as a doc comment. When the header was a multi-line `//` run and the SDK import was not the first import, the new import landed between two header lines instead. Neither is corrected by the formatter the migration guide points at. The block is now detached for the duration of the rewrite and restored verbatim; a comment above a mid-file import still travels with that import.
