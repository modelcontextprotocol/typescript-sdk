---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Register `google-duration` format on default AJV instances to silence "unknown format" warnings.

Firebase MCP and other Google Cloud API MCP servers use the `google-duration` format in their JSON Schemas (values like `"3600s"`, `"1.5s"`). AJV logs `unknown format "google-duration" ignored` warnings for each schema that references it, creating noisy startup output. The format is registered with a regex matching Google's Duration proto format: a number followed by a time unit suffix (`s`, `ms`, `us`, `ns`, `m`, `h`, `d`).
