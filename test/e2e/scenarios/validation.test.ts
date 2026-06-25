/**
 * Self-contained test bodies for the pluggable JSON Schema validation surface.
 *
 * The SDK validates tool `structuredContent` on the client against the tool's
 * advertised `outputSchema`, using the provider passed as
 * `ClientOptions.jsonSchemaValidator` (Ajv by default). These bodies prove the
 * provider is genuinely pluggable: the Cloudflare-Workers-compatible provider
 * yields the same accept/reject outcomes as the default, and a custom provider
 * is actually invoked for schema compilation and validation.
 *
 * The server side is a low-level {@link Server} that does NOT pre-validate its
 * own output — that is what makes the client-side validation observable.
 */

import { Client } from '@modelcontextprotocol/client';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, StandardSchemaWithJSON } from '@modelcontextprotocol/core';
import type { Tool } from '@modelcontextprotocol/server';
import {
    fromJsonSchema,
    isSpecType,
    McpServer,
    ProtocolError,
    ProtocolErrorCode,
    Server,
    specTypeSchemas
} from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs, Transport } from '../types';

const FORECAST_OUTPUT_SCHEMA: Tool['outputSchema'] = {
    type: 'object',
    properties: { celsius: { type: 'integer' }, summary: { type: 'string' } },
    required: ['celsius', 'summary'],
    additionalProperties: false
};

/**
 * Low-level Server exposing two forecast tools that share an outputSchema:
 * `forecast` returns conforming structured content, `forecast-corrupted`
 * returns a non-conforming payload (string where an integer is required).
 * No server-side validation happens here, so the client's validator decides.
 */
function forecastServer(): Server {
    const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
    s.setRequestHandler('tools/list', () => ({
        tools: [
            {
                name: 'forecast',
                description: 'Current temperature forecast.',
                inputSchema: { type: 'object' },
                outputSchema: FORECAST_OUTPUT_SCHEMA
            },
            {
                name: 'forecast-corrupted',
                description: 'Forecast whose payload violates its own output schema.',
                inputSchema: { type: 'object' },
                outputSchema: FORECAST_OUTPUT_SCHEMA
            }
        ]
    }));
    s.setRequestHandler('tools/call', req => {
        if (req.params.name === 'forecast') {
            const structuredContent = { celsius: 21, summary: 'mild and sunny' };
            return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
        }
        const corrupted = { celsius: 'mild', summary: 42 };
        return { structuredContent: corrupted, content: [{ type: 'text', text: JSON.stringify(corrupted) }] };
    });
    return s;
}

/**
 * Wire a fresh client (built by `makeClient`) to a fresh forecast server, then
 * exercise the accept and reject paths once each. Returns what the provider
 * decided so callers can compare providers against each other.
 */
async function runForecastOutcomes(transport: Transport, makeClient: () => Client) {
    const client = makeClient();
    await using _ = await wire(transport, forecastServer, client);

    // listTools() primes the client's output-schema validator cache — this is
    // where the configured provider compiles the schema.
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).toSorted()).toEqual(['forecast', 'forecast-corrupted']);

    const accepted = await client.callTool({ name: 'forecast', arguments: {} });

    let rejection: ProtocolError | undefined;
    try {
        await client.callTool({ name: 'forecast-corrupted', arguments: {} });
    } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        rejection = error;
    }

    return { acceptedStructuredContent: accepted.structuredContent, rejection };
}

verifies('validation:cfworker-provider', async ({ transport }: TestArgs) => {
    const ajv = await runForecastOutcomes(transport, () => new Client({ name: 'c', version: '0' }));
    const cfworker = await runForecastOutcomes(
        transport,
        () => new Client({ name: 'c', version: '0' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() })
    );

    // Both providers accept the conforming payload and hand back the same data.
    expect(ajv.acceptedStructuredContent).toEqual({ celsius: 21, summary: 'mild and sunny' });
    expect(cfworker.acceptedStructuredContent).toEqual(ajv.acceptedStructuredContent);

    // Both providers reject the non-conforming payload the same way: an
    // McpError with the same code, pointing at the output-schema mismatch.
    expect(ajv.rejection).toBeInstanceOf(ProtocolError);
    expect(cfworker.rejection).toBeInstanceOf(ProtocolError);
    expect(ajv.rejection?.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(cfworker.rejection?.code).toBe(ajv.rejection?.code);
    expect(ajv.rejection?.message).toMatch(/output schema|structured content/i);
    expect(cfworker.rejection?.message).toMatch(/output schema|structured content/i);
});

/**
 * Provider that records every schema it compiles and every value it is asked
 * to validate, delegating verdicts to the default Ajv provider.
 */
class RecordingValidatorProvider implements jsonSchemaValidator {
    readonly compiledSchemas: JsonSchemaType[] = [];
    readonly validatedValues: unknown[] = [];
    private readonly delegate = new AjvJsonSchemaValidator();

    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        this.compiledSchemas.push(schema);
        const inner = this.delegate.getValidator<T>(schema);
        return input => {
            this.validatedValues.push(input);
            return inner(input);
        };
    }
}

verifies('validation:pluggable-provider', async ({ transport }: TestArgs) => {
    const recorder = new RecordingValidatorProvider();
    const client = new Client({ name: 'c', version: '0' }, { jsonSchemaValidator: recorder });
    await using _ = await wire(transport, forecastServer, client);

    await client.listTools();

    // The custom provider compiled the advertised outputSchema (once per tool
    // that declares one — both forecast tools share the same schema).
    expect(recorder.compiledSchemas).toEqual([FORECAST_OUTPUT_SCHEMA, FORECAST_OUTPUT_SCHEMA]);

    // The custom provider's validator is the one consulted on tools/call, and
    // its (delegated) verdict is what the caller sees.
    const result = await client.callTool({ name: 'forecast', arguments: {} });
    expect(result.structuredContent).toEqual({ celsius: 21, summary: 'mild and sunny' });
    expect(recorder.validatedValues).toEqual([{ celsius: 21, summary: 'mild and sunny' }]);

    await expect(client.callTool({ name: 'forecast-corrupted', arguments: {} })).rejects.toBeInstanceOf(ProtocolError);
    expect(recorder.validatedValues).toEqual([
        { celsius: 21, summary: 'mild and sunny' },
        { celsius: 'mild', summary: 42 }
    ]);
});

/** Raw JSON Schema registered via fromJsonSchema(); the `greet` tool both advertises it and validates arguments against it. */
const GREET_INPUT_SCHEMA: JsonSchemaType = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false
};

/**
 * McpServer factory-of-factories for the fromJsonSchema tests: registers a single
 * `greet` tool with the given (already wrapped) inputSchema and pushes every
 * handler invocation's arguments into `handlerArgs` so tests can prove whether
 * the handler ran. The recorder lives outside the factory because per-session /
 * stateless hosting builds a fresh server per session or request.
 */
function greetServerFactory(inputSchema: StandardSchemaWithJSON<{ name: string }>, handlerArgs: unknown[]): () => McpServer {
    return () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('greet', { description: 'Greets the caller by name.', inputSchema }, ({ name }) => {
            handlerArgs.push({ name });
            return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
        });
        return s;
    };
}

verifies('validators:from-json-schema:tool-roundtrip', async ({ transport }: TestArgs) => {
    const handlerArgs: unknown[] = [];
    const client = new Client({ name: 'c', version: '0' });
    await using _ = await wire(transport, greetServerFactory(fromJsonSchema<{ name: string }>(GREET_INPUT_SCHEMA), handlerArgs), client);

    // tools/list advertises the wrapped raw JSON Schema as-is.
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['greet']);
    expect(tools[0]?.inputSchema).toEqual(GREET_INPUT_SCHEMA);

    // Conforming arguments reach the handler end to end and the call resolves with its result.
    const result = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'Hello, Ada!' }]);
    expect(handlerArgs).toEqual([{ name: 'Ada' }]);
});

verifies('validators:from-json-schema:invalid-args-rejected', async ({ transport }: TestArgs) => {
    const handlerArgs: unknown[] = [];
    const client = new Client({ name: 'c', version: '0' });
    await using _ = await wire(transport, greetServerFactory(fromJsonSchema<{ name: string }>(GREET_INPUT_SCHEMA), handlerArgs), client);

    // Arguments violating the wrapped JSON Schema (`name` must be a string) are rejected with JSON-RPC -32602.
    const rejected = client.callTool({ name: 'greet', arguments: { name: 42 } });
    await expect(rejected).rejects.toBeInstanceOf(ProtocolError);
    await expect(rejected).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });

    // The handler was never invoked for the rejected call.
    expect(handlerArgs).toEqual([]);
});

/**
 * jsonSchemaValidator for the override test: delegates verdicts to Ajv but
 * records every compile/validate call and additionally vetoes the
 * schema-conforming arguments `{ name: 'vetoed' }`, so its decisions are
 * observably different from the runtime default validator's.
 */
class VetoingRecordingValidator implements jsonSchemaValidator {
    readonly compiledSchemas: JsonSchemaType[] = [];
    readonly validatedInputs: unknown[] = [];
    private readonly delegate = new AjvJsonSchemaValidator();

    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        this.compiledSchemas.push(schema);
        const inner = this.delegate.getValidator<T>(schema);
        return input => {
            this.validatedInputs.push(input);
            // Veto a value the JSON Schema accepts so the call outcome provably reflects this validator, not the default.
            if (z.object({ name: z.literal('vetoed') }).safeParse(input).success) {
                return { valid: false, data: undefined, errorMessage: 'vetoed name rejected by the custom validator override' };
            }
            return inner(input);
        };
    }
}

verifies('validators:custom-validator:override', async ({ transport }: TestArgs) => {
    const recorder = new VetoingRecordingValidator();
    const handlerArgs: unknown[] = [];
    const client = new Client({ name: 'c', version: '0' });
    await using _ = await wire(
        transport,
        greetServerFactory(fromJsonSchema<{ name: string }>(GREET_INPUT_SCHEMA, recorder), handlerArgs),
        client
    );

    // The supplied validator (not the runtime default) compiled the registered schema.
    expect(recorder.compiledSchemas).toEqual([GREET_INPUT_SCHEMA]);

    // The supplied validator is consulted on tools/call and its accept verdict lets the handler run.
    const accepted = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });
    expect(accepted.content).toEqual([{ type: 'text', text: 'Hello, Ada!' }]);
    expect(recorder.validatedInputs).toEqual([{ name: 'Ada' }]);

    // 'vetoed' conforms to the JSON Schema (the default validator would run the handler), so only the supplied validator can gate it.
    const vetoOutcome = await client.callTool({ name: 'greet', arguments: { name: 'vetoed' } }).catch((error: unknown) => error);
    const vetoText = vetoOutcome instanceof Error ? vetoOutcome.message : JSON.stringify(vetoOutcome);
    expect(vetoText).toContain('vetoed name rejected by the custom validator override');
    expect(recorder.validatedInputs).toEqual([{ name: 'Ada' }, { name: 'vetoed' }]);
    expect(handlerArgs).toEqual([{ name: 'Ada' }]);
});

/** McpServer factory exposing a single `ping-tool` returning a fixed text block — fixture for the spec-type guard tests. */
function pingToolServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerTool('ping-tool', { inputSchema: z.object({}) }, () => ({ content: [{ type: 'text', text: 'pong' }] }));
    return s;
}

verifies('guards:spec-type:call-tool-result', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'c', version: '0' });
    await using _ = await wire(transport, pingToolServer, client);

    // Hold the live result as `unknown` so the guard is what narrows it for the caller.
    const result: unknown = await client.callTool({ name: 'ping-tool', arguments: {} });

    expect(isSpecType.CallToolResult(result)).toBe(true);
    if (isSpecType.CallToolResult(result)) {
        // Narrowed without casts: the guarded value exposes the spec-typed content array.
        expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    }

    // Structurally non-conforming values are rejected ({} is avoided here: content has a default, so the input-type guard accepts it).
    expect(isSpecType.CallToolResult({ content: 'nope' })).toBe(false);
    expect(isSpecType.CallToolResult(42)).toBe(false);
});

verifies('guards:spec-type-schemas:sync-validate', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'c', version: '0' });
    await using _ = await wire(transport, pingToolServer, client);

    const result = await client.callTool({ name: 'ping-tool', arguments: {} });

    // Synchronous Standard Schema: validate() hands back the result object directly, never a Promise.
    const accepted = specTypeSchemas.CallToolResult['~standard'].validate(result);
    expect(accepted).not.toBeInstanceOf(Promise);
    expect(accepted.issues).toBeUndefined();
    if (accepted.issues === undefined) {
        expect(accepted.value.content).toEqual([{ type: 'text', text: 'pong' }]);
    }

    const rejected = specTypeSchemas.CallToolResult['~standard'].validate({ content: 'nope' });
    expect(rejected).not.toBeInstanceOf(Promise);
    expect(rejected.issues).toBeDefined();
    expect(rejected.issues?.length).toBeGreaterThan(0);
});
