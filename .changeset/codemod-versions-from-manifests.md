---
'@modelcontextprotocol/codemod': patch
---

Read the v2 package versions the codemod writes into migrated `package.json` files directly from the workspace manifests at build time, replacing the committed generated `versions.ts` (which went stale after every release and made source builds write outdated versions).
