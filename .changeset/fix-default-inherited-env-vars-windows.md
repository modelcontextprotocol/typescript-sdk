---
'@modelcontextprotocol/client': patch
---

Add missing Windows environment variables to `DEFAULT_INHERITED_ENV_VARS`: `PATHEXT`, `COMSPEC`, `PROGRAMFILES(X86)`, `PROGRAMW6432`, and `WINDIR`. Without `PATHEXT`, spawning common tools like `npm` or `git` from a stdio MCP server fails with `ENOENT` on Windows because Node can't resolve the `.cmd`/`.exe` extension.
