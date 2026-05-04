---
"@modelcontextprotocol/client": patch
---

Fix custom claims not overriding reserved JWT claims in createPrivateKeyJwtAuth

Remove redundant jose setter calls (setIssuer, setSubject, setAudience, setIssuedAt,
setExpirationTime, setJti) that silently overwrote user-provided custom claims, making
the runtime behavior match the documented contract that custom claims take precedence
for overlapping keys.
