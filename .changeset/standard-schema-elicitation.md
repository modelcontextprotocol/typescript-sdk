---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/server': minor
---

Allow `inputRequired.elicit()` to accept a Standard Schema such as a Zod object for `requestedSchema`. The builder converts it to MCP's restricted form-elicitation JSON Schema, while the same schema can validate and type the response through `acceptedContent()` on handler re-entry. Zod formats mapping to `email`, `uri`, `date`, and `date-time` are supported. Shapes the restricted schema cannot express reject before anything is sent — nested objects, `.regex()` and customized zod format patterns, exclusive number bounds (`.positive()`/`.gt()`), literal unions (use `z.enum` or `z.literal(['a', 'b'])`), and non-spec root keywords like `z.strictObject()`'s `additionalProperties`.
