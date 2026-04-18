---
'@modelcontextprotocol/client': patch
---

Always set `windowsHide` when spawning stdio server processes on Windows, not just in Electron environments. Prevents unwanted console windows in non-Electron Windows applications.
