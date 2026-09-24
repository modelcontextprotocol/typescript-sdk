---
'@modelcontextprotocol/sdk': patch
---

Silence unknown-format warnings from the default AJV validator. Servers using custom formats no longer spam one warning per subschema on listTools; other warnings and known-format validation are unchanged.
