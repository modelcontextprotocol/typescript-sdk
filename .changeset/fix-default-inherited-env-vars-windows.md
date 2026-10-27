---
'@modelcontextprotocol/sdk': patch
---

On Windows, stdio servers spawned by `StdioClientTransport` now also inherit `COMSPEC`, `PATHEXT`, `PROGRAMDATA`, `PROGRAMFILES(X86)`, `PROGRAMW6432`, and `WINDIR` (added to `DEFAULT_INHERITED_ENV_VARS`). Programs a server launches can depend on them: PowerShell finds no native
executables without `PATHEXT`, and Windows OpenSSH exits 255 without `ProgramData`.

This is a backport of the same fix already merged on `main` in #2043, and resolves #2037 for the v1 line.
