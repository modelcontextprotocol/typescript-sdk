---
shape: how-to
---
# Schema libraries

## Register a tool with an ArkType schema

`inputSchema` accepts any **Standard Schema** that can produce JSON Schema — ArkType works as-is, no wrapper, exactly like the Zod schemas in [Tools](../servers/tools.md).

```ts source="../../examples/guides/advanced/schema-libraries.examples.ts#registerTool_arktype"
import { McpServer } from '@modelcontextprotocol/server';
import { type } from 'arktype';

const server = new McpServer({ name: 'schema-zoo', version: '1.0.0' });

server.registerTool(
    'greet',
    {
        description: 'Greet someone by name',
        inputSchema: type({ name: 'string', 'times?': '1 <= number.integer <= 5' })
    },
    async ({ name, times }) => ({
        content: [{ type: 'text', text: Array.from({ length: times ?? 1 }, () => `Hello, ${name}`).join('\n') }]
    })
);
```

From that one schema the SDK derives the JSON Schema the model sees, validates arguments before your handler runs, and infers the handler's argument types — `name` is `string`, `times` is `number | undefined`.

Every call on this page comes from an in-memory `Client` connected to this server — [Test a server](../testing.md) shows that wiring. Call `greet` with `times: 99` and the SDK rejects the call with ArkType's own message; the handler never runs:

```
{
  content: [
    {
      type: 'text',
      text: 'Input validation error: Invalid arguments for tool greet: times: times must be at most 5 (was 99)'
    }
  ],
  isError: true
}
```

::: info Coming from v1?
Raw shapes (`inputSchema: { name: z.string() }`) are deprecated — pass a schema object. See the [upgrade guide](../migration/upgrade-to-v2.md).
:::

## Register a tool with a Valibot schema

Valibot does not expose JSON Schema conversion on the schema itself — wrap it with `toStandardJsonSchema` from `@valibot/to-json-schema`.

```ts source="../../examples/guides/advanced/schema-libraries.examples.ts#registerTool_valibot"
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

server.registerTool(
    'shout',
    { description: 'Greet someone, loudly', inputSchema: toStandardJsonSchema(v.object({ name: v.string() })) },
    async ({ name }) => ({ content: [{ type: 'text', text: `HELLO, ${name.toUpperCase()}` }] })
);
```

`tools/list` now advertises `shout` with the JSON Schema the wrapper derives, and Valibot parses every call that reaches the handler.

## Start from JSON Schema you already have

`fromJsonSchema` (exported from `@modelcontextprotocol/server`) wraps a plain JSON Schema document so you can register it without a schema library. The generic parameter types the handler's arguments; omit it and they are `unknown`.

```ts source="../../examples/guides/advanced/schema-libraries.examples.ts#registerTool_fromJsonSchema"
import { fromJsonSchema } from '@modelcontextprotocol/server';

server.registerTool(
    'farewell',
    {
        description: 'Say goodbye',
        inputSchema: fromJsonSchema<{ name: string }>({
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        })
    },
    async ({ name }) => ({ content: [{ type: 'text', text: `Goodbye, ${name}` }] })
);
```

`tools/list` advertises the document you passed, unchanged:

```
{
  type: 'object',
  properties: { name: { type: 'string' } },
  required: [ 'name' ]
}
```

The SDK checks every call against it with a real **JSON Schema validator** — the last two sections pick which one.

## Validate structured output with any library

`outputSchema` — and a prompt's `argsSchema` — follow the same Standard Schema rule. Return the matching value as `structuredContent`, next to the human-readable `content`.

```ts source="../../examples/guides/advanced/schema-libraries.examples.ts#registerTool_outputSchema"
server.registerTool(
    'measure',
    {
        description: 'Measure the length of a name',
        inputSchema: type({ name: 'string' }),
        outputSchema: type({ name: 'string', length: 'number' })
    },
    async ({ name }) => {
        const output = { name, length: name.length };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }
);
```

The SDK validates `structuredContent` against the ArkType schema before the result leaves your server. Calling `measure` with `{ name: 'Ada' }` returns both renderings:

```
{
  content: [ { type: 'text', text: '{"name":"Ada","length":3}' } ],
  structuredContent: { name: 'Ada', length: 3 }
}
```

## Swap the JSON Schema validator

The server runs a JSON Schema validator in two places: a `fromJsonSchema` schema, and [elicitation](../servers/elicitation.md) form responses. Build one from the `validators/ajv` subpath, which re-exports the SDK's bundled `Ajv` and `addFormats`.

```ts source="../../examples/guides/advanced/schema-libraries.examples.ts#jsonSchemaValidator_ajv"
import { addFormats, Ajv, AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validator = new AjvJsonSchemaValidator(ajv);

const strict = new McpServer({ name: 'schema-zoo', version: '1.0.0' }, { jsonSchemaValidator: validator });
```

`strict` now checks elicitation form responses with your `Ajv` instance.

::: warning
`jsonSchemaValidator` covers elicitation form responses only. A `fromJsonSchema` schema binds its validator at creation — pass yours as the second argument: `fromJsonSchema(document, validator)`.
:::

## Pick the validator for your runtime

Leave `jsonSchemaValidator` unset and the SDK selects by runtime: AJV on Node.js, `@cfworker/json-schema` on workerd and in browsers. Import from the `validators/cf-worker` subpath to pin the lightweight one anywhere.

```ts source="../../examples/guides/advanced/schema-libraries.examples.ts#jsonSchemaValidator_cfWorker"
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';

const edge = new McpServer({ name: 'schema-zoo', version: '1.0.0' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
```

`edge` runs the same two validation paths through `@cfworker/json-schema` instead of AJV, on any runtime.

## Recap

- `inputSchema`, `outputSchema`, and a prompt's `argsSchema` accept any Standard Schema that exposes JSON Schema — Zod and ArkType as-is, Valibot through `@valibot/to-json-schema`.
- The raw-shape overload (`inputSchema: { name: z.string() }`) is deprecated; pass a schema object.
- `fromJsonSchema(document)` registers a JSON Schema you already have; the generic parameter types the handler's arguments.
- `jsonSchemaValidator` on the server options swaps the validator for elicitation form responses; `fromJsonSchema` takes its own as a second argument.
- The default validator is runtime-selected — AJV on Node.js, `@cfworker/json-schema` on workerd and browsers — and the `validators/ajv` and `validators/cf-worker` subpaths force either one.
