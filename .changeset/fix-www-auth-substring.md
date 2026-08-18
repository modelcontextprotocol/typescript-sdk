---
'@modelcontextprotocol/client': patch
---

Fix `WWW-Authenticate` parsing matching a field name inside another auth-param. The OAuth client extracted `resource_metadata`, `scope`, `error`, and `error_description` with a regex that searched for the field name anywhere in the header, so a different parameter whose name ended with the requested field (for example `error_scope` when reading `scope`) could shadow the real value, and a parameter like `x_resource_metadata` could supply a decoy resource metadata URL. The parameter name is now anchored to the header start or a separator.
