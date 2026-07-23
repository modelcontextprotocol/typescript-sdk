---
'@modelcontextprotocol/client': minor
---

The response cache now stores results as JSON-serialized documents (serialize on write, parse on read) instead of live object graphs isolated with `structuredClone`. Same mutation isolation, but no dependency on the `structuredClone` global — whose absence (jest+jsdom, Node < 17) previously made every cache write throw into the store-error swallow, silently disabling caching and output-schema lookups for the session. A value without a JSON representation now fails the write loudly to the error sink, and an undecodable document in an external store is reported, dropped, and read as a miss.

Migration for custom `ResponseCacheStore` implementations: `CacheEntry.value` (and the `set()` entry value) is now `string` — persist and return it verbatim, `JSON.parse` to inspect. Entries persisted by a previous SDK version fail decode once (reported, dropped) and are rewritten on the next fetch.
