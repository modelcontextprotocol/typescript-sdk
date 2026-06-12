---
'@modelcontextprotocol/client': patch
---

Continue authorization server metadata discovery when a candidate well-known endpoint returns HTTP 200 with a non-JSON body, allowing fallback to the next OAuth/OIDC discovery URL.
