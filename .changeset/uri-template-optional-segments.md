---
'@modelcontextprotocol/core-internal': patch
---

`UriTemplate` now handles optional segments, so a `ResourceTemplate` with an optional variable resolves whether or not the segment is present (#677).

- `{name?}`: the trailing `?` is no longer kept as part of the variable name. `variableNames` reports `name`, `expand()` uses the `name` key and omits the segment together with its leading `/` when the value is absent, and `match()` accepts the URI with or without that segment.
- `{/name}` and `{.name}`: `match()` now accepts the URI that `expand()` produces when the variable is undefined, instead of returning `null`.
