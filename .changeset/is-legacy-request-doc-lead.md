---
'@modelcontextprotocol/server': patch
---

`isLegacyRequest` docs: lead with the single-argument form. `isLegacyRequest(request)` is the whole API — the body is read from an internal clone, so the request you pass stays readable for whichever handler you route it to. `parsedBody` is an optional perf escape for a body you already hold parsed (and the way in for an already-consumed stream, e.g. behind `express.json()`), not a required companion. Documentation only; no behavior change.
