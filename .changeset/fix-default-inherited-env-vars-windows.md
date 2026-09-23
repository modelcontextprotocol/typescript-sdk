---
'@modelcontextprotocol/client': patch
---

On Windows, stdio servers spawned by `StdioClientTransport` now also inherit `COMSPEC`, `PATHEXT`, `PROGRAMDATA`, `PROGRAMFILES(X86)`, `PROGRAMW6432`, and `WINDIR` (added to `DEFAULT_INHERITED_ENV_VARS`). Programs a server launches can depend on them: PowerShell finds no native executables without `PATHEXT`, and Windows OpenSSH exits 255 without `ProgramData`.
