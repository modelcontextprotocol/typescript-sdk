## Tools

Tools let MCP clients ask your server to take actions. They are usually the
main way that LLMs call into your application.

A typical registration with `registerTool` looks like this:

```typescript
server.registerTool(
    'calculate-bmi',
    {
        title: 'BMI Calculator',
        description: 'Calculate Body Mass Index',
        inputSchema: {
            weightKg: z.number(),
            heightM: z.number()
        },
        outputSchema: { bmi: z.number() }
    },
    async ({ weightKg, heightM }) => {
        const output = { bmi: weightKg / (heightM * heightM) };
        return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output
        };
    }
);
```

This snippet is illustrative only; for runnable servers that expose tools, see:

- `src/examples/server/simpleStreamableHttp.ts`
- `src/examples/server/toolWithSampleServer.ts`

### ResourceLink outputs

Tools can return `resource_link` content items to reference large resources
without embedding them directly, allowing clients to fetch only what they need.

The README’s `list-files` example shows the pattern conceptually; for concrete
usage, see the Streamable HTTP examples in `src/examples/server`.

## Resources

Resources expose data to clients, but should not perform heavy computation or
side‑effects. They are ideal for configuration, documents, or other reference
data.

Conceptually, you might register resources like:

```typescript
server.registerResource(
    'config',
    'config://app',
    {
        title: 'Application Config',
        description: 'Application configuration data',
        mimeType: 'text/plain'
    },
    async uri => ({
        contents: [{ uri: uri.href, text: 'App configuration here' }]
    })
);
```

Dynamic resources use `ResourceTemplate` and can support completions on path
parameters. For full runnable examples of resources:

- `src/examples/server/simpleStreamableHttp.ts`

## Prompts

Prompts are reusable templates that help humans (or client UIs) talk to models
in a consistent way. They are declared on the server and listed through MCP.

A minimal prompt:

```typescript
server.registerPrompt(
    'review-code',
    {
        title: 'Code Review',
        description: 'Review code for best practices and potential issues',
        argsSchema: { code: z.string() }
    },
    ({ code }) => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `Please review this code:\n\n${code}`
                }
            }
        ]
    })
);
```

For prompts integrated into a full server, see:

- `src/examples/server/simpleStreamableHttp.ts`

## Completions

Both prompts and resources can support argument completions. On the client
side, you use `client.complete()` with a reference to the prompt or resource
and the partially‑typed argument.

See the MCP spec sections on prompts and resources for complete details, and
`src/examples/client/simpleStreamableHttp.ts` for client‑side usage patterns.

## Display names and metadata

Tools, resources and prompts support a `title` field for human‑readable names.
Older APIs can also attach `annotations.title`. To compute the correct display
name on the client, use:

- `getDisplayName` from `@modelcontextprotocol/sdk/shared/metadataUtils.js`



