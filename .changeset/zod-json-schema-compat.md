---
'@modelcontextprotocol/core': patch
---

Allow additional JSON Schema properties in elicitInput's requestedSchema type by adding .catchall(z.unknown()), matching the pattern used by inputSchema. This fixes type incompatibility when using Zod v4's .toJSONSchema() output which includes extra properties like $schema and additionalProperties.
