---
'@modelcontextprotocol/codemod': patch
---

The `v1-to-v2` codemod now writes rewritten imports where the first v1 import stood, not at the top of the file, so a license header, `// @ts-nocheck`, `/// <reference>` or a `'use client'` / `'use server'` / `'use strict'` directive above it stays in place. Known gap: when a later step of the codemod replaces or removes the import (for example a file whose only SDK import is `ErrorCode` or `StreamableHTTPError`), the new import can still land above or inside the header, and a `/** */` header can be removed. Files already migrated with codemod 2.1.0 or earlier are not repaired; check the top of those files.
