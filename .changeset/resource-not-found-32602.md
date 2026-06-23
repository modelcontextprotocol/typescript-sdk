---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/server": major
"@modelcontextprotocol/client": minor
---

`resources/read` for an unknown URI now answers with JSON-RPC error code `-32602`
(Invalid Params) on every protocol revision, with `error.data.uri` echoing the
requested URI. The 2026-07-28 specification requires `-32602`; the v1.x SDK already
emitted `-32602` on earlier revisions, so v1.x peers see no change.

This supersedes an interim `-32002` emission that shipped in earlier v2 alphas. The
era-aware encode seam (`WireCodec.encodeErrorCode`) maps any handler-thrown `-32002`
to `-32602` on the wire, so a handler written against the older alpha behaves
identically without changes.

`ProtocolErrorCode.ResourceNotFound` (`-32002`) remains importable as receive-tolerated
vocabulary; clients should accept both `-32602` and `-32002` from peers (the
specification's backwards-compatibility clause). The new typed `ResourceNotFoundError`
class carries `data.uri`, and `ProtocolError.fromError` recognises both codes by the
`data.uri` shape.
