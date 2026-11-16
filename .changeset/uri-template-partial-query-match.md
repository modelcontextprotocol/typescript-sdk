---
'@modelcontextprotocol/core-internal': patch
---

Let `UriTemplate.match` read a query pair that is not the first name of the expression: `expand` drops a variable that is undefined, so `{?q,page}` with only `page` set produces `?page=1`, which the matcher rejected because every pair after the first had to start with `&`.
