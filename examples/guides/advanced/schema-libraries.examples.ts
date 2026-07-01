/**
 * Companion example for `docs/advanced/schema-libraries.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory client and produces the output the page quotes
 * verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/advanced/schema-libraries.examples.ts   # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region registerTool_arktype
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
//#endregion registerTool_arktype

//#region registerTool_valibot
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

server.registerTool(
    'shout',
    { description: 'Greet someone, loudly', inputSchema: toStandardJsonSchema(v.object({ name: v.string() })) },
    async ({ name }) => ({ content: [{ type: 'text', text: `HELLO, ${name.toUpperCase()}` }] })
);
//#endregion registerTool_valibot

//#region registerTool_fromJsonSchema
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
//#endregion registerTool_fromJsonSchema

//#region registerTool_outputSchema
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
//#endregion registerTool_outputSchema

//#region jsonSchemaValidator_ajv
import { addFormats, Ajv, AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validator = new AjvJsonSchemaValidator(ajv);

const strict = new McpServer({ name: 'schema-zoo', version: '1.0.0' }, { jsonSchemaValidator: validator });
//#endregion jsonSchemaValidator_ajv

//#region jsonSchemaValidator_cfWorker
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';

const edge = new McpServer({ name: 'schema-zoo', version: '1.0.0' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
//#endregion jsonSchemaValidator_cfWorker

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client drives the calls whose
// output advanced/schema-libraries.md quotes verbatim. Any MCP client behaves
// the same. Imported dynamically so the page's lead region stays
// self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'schema-libraries-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Register a tool with an ArkType schema" — the rejection the page quotes.
const rejected = await client.callTool({ name: 'greet', arguments: { name: 'Ada', times: 99 } });
console.log(rejected);

// "Register a tool with a Valibot schema" — proves the page's prose claim that
// the call validates and dispatches like any other tool.
const shouted = await client.callTool({ name: 'shout', arguments: { name: 'Ada' } });
if (JSON.stringify(shouted.content) !== JSON.stringify([{ type: 'text', text: 'HELLO, ADA' }])) {
    throw new Error(`schema-libraries.md valibot claim failed: ${JSON.stringify(shouted)}`);
}

// "Start from JSON Schema you already have" — the advertised schema the page quotes.
const { tools } = await client.listTools();
const farewell = tools.find(tool => tool.name === 'farewell');
console.log(farewell?.inputSchema);

// "Validate structured output with any library" — the structured result the page quotes.
const measured = await client.callTool({ name: 'measure', arguments: { name: 'Ada' } });
console.log(measured);

await client.close();
await server.close();
await strict.close();
await edge.close();
