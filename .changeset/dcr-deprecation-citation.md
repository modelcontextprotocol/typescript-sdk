---
'@modelcontextprotocol/client': patch
---

Correct the `registerClient` `@deprecated` notice: Dynamic Client Registration was deprecated by spec PR modelcontextprotocol#2858 (Client ID Metadata Documents), not SEP-2577 (which deprecates roots, sampling, and logging). The notice now also names the earliest possible removal date under the feature lifecycle policy (2027-07-28) and clarifies that the `client_id_metadata_document_supported` gating lives in the built-in `auth()` flow — `registerClient` called directly always sends the registration request. Documentation only; no runtime behavior change.
