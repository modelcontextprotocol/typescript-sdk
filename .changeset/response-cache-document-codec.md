---
'@modelcontextprotocol/client': minor
---

The response cache now stores results as their JSON-serialized documents (serialize on write, parse on read) instead of holding live object graphs isolated with `structuredClone`. Every cache hit hands the caller a freshly parsed value it owns outright — same mutation isolation as before, without depending on the `structuredClone` global (whose absence in jest+jsdom and Node < 17 previously made every cache write throw into the store-error swallow, silently disabling caching and output-schema lookups for the whole session). In-memory and persistent stores now behave identically: `CacheEntry.value` is a string a Redis-style store persists verbatim. A value that is not JSON-serializable (only reachable via in-process transports handing over non-wire objects) now fails the write loudly to the error sink instead of silently, and a corrupted document in an external store reads as a reported miss instead of an uncaught throw.

Migration for custom `ResponseCacheStore` implementations: `CacheEntry.value` (and the `set()` entry) is now `string`. A store that serialized on `set` and parsed on `get` must stop parsing — return the stored string verbatim. A store that inspected `entry.value` as an object must `JSON.parse` it. Entries persisted by a previous SDK version fail decode once (reported miss) and self-heal on the next write.
