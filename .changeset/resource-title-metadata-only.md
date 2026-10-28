---
'@modelcontextprotocol/server': patch
---

A resource or resource template registered with a `title` keeps advertising it in `resources/list` and `resources/templates/list` after `update({ metadata })`, which replaces the metadata carrier wholesale. Both list paths now derive the field from the registered title when the new metadata does not carry one; metadata that does carry a `title` still wins.
