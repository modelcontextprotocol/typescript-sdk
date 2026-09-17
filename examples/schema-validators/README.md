# schema-validators

Tool input/output schemas via Zod, ArkType and Valibot — any Standard-Schema-with-JSON library works. Also shows `outputSchema` → `structuredContent`, including an array-root `outputSchema` (SEP-2106) with the auto-injected `TextContent` fallback and the client-side `unknown` runtime-narrowing pattern.

```bash
pnpm tsx examples/schema-validators/client.ts
```
