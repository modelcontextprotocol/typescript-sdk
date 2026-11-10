---
'@modelcontextprotocol/server': patch
---

Keep `title` and `metadata.title` synchronized on `registeredResource.update` and `registeredResourceTemplate.update` when updating metadata alone. If new metadata specifies a `title`, it is synchronized to the top-level property; if new metadata omits `title`, any existing top-level title is preserved in metadata rather than being dropped from resource listings.
