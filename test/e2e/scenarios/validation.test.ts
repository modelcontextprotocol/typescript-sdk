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

import { expect } from 'vitest';

import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from '../../../src/types.js';
import { AjvJsonSchemaValidator } from '../../../src/validation/ajv-provider.js';
import { CfWorkerJsonSchemaValidator } from '../../../src/validation/cfworker-provider.js';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from '../../../src/validation/types.js';

import { wire } from '../helpers/index.js';
import type { TestArgs, Transport } from '../types.js';
import { verifies } from '../helpers/verifies.js';

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
    s.setRequestHandler(ListToolsRequestSchema, () => ({
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
    s.setRequestHandler(CallToolRequestSchema, req => {
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
async function runForecastOutcomes(cell: TestArgs, makeClient: () => Client) {
    const client = makeClient();
    await using _ = await wire(cell, forecastServer, client);

    // listTools() primes the client's output-schema validator cache — this is
    // where the configured provider compiles the schema.
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['forecast', 'forecast-corrupted']);

    const accepted = await client.callTool({ name: 'forecast', arguments: {} });

    let rejection: McpError | undefined;
    try {
        await client.callTool({ name: 'forecast-corrupted', arguments: {} });
    } catch (e) {
        if (!(e instanceof McpError)) throw e;
        rejection = e;
    }

    return { acceptedStructuredContent: accepted.structuredContent, rejection };
}

verifies('validation:cfworker-provider', async ({ transport, protocolVersion }: TestArgs) => {
    const ajv = await runForecastOutcomes({ transport, protocolVersion }, () => new Client({ name: 'c', version: '0' }));
    const cfworker = await runForecastOutcomes(
        { transport, protocolVersion },
        () => new Client({ name: 'c', version: '0' }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() })
    );

    // Both providers accept the conforming payload and hand back the same data.
    expect(ajv.acceptedStructuredContent).toEqual({ celsius: 21, summary: 'mild and sunny' });
    expect(cfworker.acceptedStructuredContent).toEqual(ajv.acceptedStructuredContent);

    // Both providers reject the non-conforming payload the same way: an
    // McpError with the same code, pointing at the output-schema mismatch.
    expect(ajv.rejection).toBeInstanceOf(McpError);
    expect(cfworker.rejection).toBeInstanceOf(McpError);
    expect(ajv.rejection?.code).toBe(ErrorCode.InvalidParams);
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

verifies('validation:pluggable-provider', async ({ transport, protocolVersion }: TestArgs) => {
    const recorder = new RecordingValidatorProvider();
    const client = new Client({ name: 'c', version: '0' }, { jsonSchemaValidator: recorder });
    await using _ = await wire({ transport, protocolVersion }, forecastServer, client);

    await client.listTools();

    // The custom provider compiled the advertised outputSchema (once per tool
    // that declares one — both forecast tools share the same schema).
    expect(recorder.compiledSchemas).toEqual([FORECAST_OUTPUT_SCHEMA, FORECAST_OUTPUT_SCHEMA]);

    // The custom provider's validator is the one consulted on tools/call, and
    // its (delegated) verdict is what the caller sees.
    const result = await client.callTool({ name: 'forecast', arguments: {} });
    expect(result.structuredContent).toEqual({ celsius: 21, summary: 'mild and sunny' });
    expect(recorder.validatedValues).toEqual([{ celsius: 21, summary: 'mild and sunny' }]);

    await expect(client.callTool({ name: 'forecast-corrupted', arguments: {} })).rejects.toBeInstanceOf(McpError);
    expect(recorder.validatedValues).toEqual([
        { celsius: 21, summary: 'mild and sunny' },
        { celsius: 'mild', summary: 42 }
    ]);
});
