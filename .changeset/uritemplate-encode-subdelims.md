---
"@modelcontextprotocol/core-internal": patch
---

Fix `UriTemplate` expansion to percent-encode `!`, `'`, `(`, `)`, and `*` for non-reserved operators, as RFC 6570 section 3.2.1 requires. `encodeURIComponent` leaves those characters unescaped, so values containing them (file names, titles, search queries) expanded to URIs that differ from what other RFC 6570 implementations emit. Reserved (`+`) and fragment (`#`) expansion is unchanged.
