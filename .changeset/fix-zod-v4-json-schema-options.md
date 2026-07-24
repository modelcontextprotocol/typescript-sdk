---
'@modelcontextprotocol/sdk': patch
---

Fix hardcoded Zod v4 `toJSONSchema` options so tool schemas match the raw `structuredContent` the server actually sends:

- `z.date()` anywhere in a tool schema no longer throws and crashes `tools/list`; it is now rendered as `{ "type": "string", "format": "date-time" }`, matching what `JSON.stringify` puts on the wire for a `Date`.
- Output-schema fields with `.default()` are no longer advertised as `required`, and `additionalProperties: false` is no longer set on output schemas. The server never runs `structuredContent` through the schema's output transform, so a tool response that legitimately omits a
  defaulted field or includes extra fields was being rejected by the client's own schema validation against the tool's advertised (but inaccurate) output schema.
