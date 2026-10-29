---
'@modelcontextprotocol/server': patch
---

A resource or resource template registered with a `title` keeps advertising it in `resources/list` and `resources/templates/list` after `update({ metadata })`, which replaces the metadata carrier wholesale. Both list paths now derive the field from the registered title when the new metadata does not carry one; metadata that does carry a `title` still wins.

`update({ metadata })` also mirrors a metadata-carried `title` onto the registered resource or template, so the fallback is always the last title written rather than the one from registration. Without that, `update({ metadata: { title: 'X' } })` followed by `update({ metadata: {} })` advertised the registration title again instead of `X`, which made the advertised title depend on the order of previous writes.
