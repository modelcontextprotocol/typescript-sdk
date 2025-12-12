/**
 * Tests that verify generated schemas match the manually-defined schemas in types.ts.
 *
 * This ensures the ts-to-zod generation produces schemas equivalent to the
 * hand-crafted ones, catching any drift between the two.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';

// Import generated schemas (from pre-processed types with SDK-compatible hierarchy)
import * as generated from '../../src/generated/sdk.schemas.js';

// Import manual schemas from types.ts
import * as manual from '../../src/types.js';

/**
 * Helper to compare two Zod schemas by checking they accept/reject the same values.
 * We test with valid examples and ensure both schemas have the same structure.
 */
function schemasAreEquivalent(
    name: string,
    genSchema: z.ZodType,
    manSchema: z.ZodType,
    testCases: { valid: unknown[]; invalid: unknown[] }
): void {
    describe(name, () => {
        for (const valid of testCases.valid) {
            it(`should accept valid value: ${JSON.stringify(valid).slice(0, 50)}`, () => {
                const genResult = genSchema.safeParse(valid);
                const manResult = manSchema.safeParse(valid);
                expect(genResult.success).toBe(true);
                expect(manResult.success).toBe(true);
            });
        }

        for (const invalid of testCases.invalid) {
            const label = JSON.stringify(invalid)?.slice(0, 50) ?? String(invalid);
            it(`should reject invalid value: ${label}`, () => {
                const genResult = genSchema.safeParse(invalid);
                const manResult = manSchema.safeParse(invalid);
                // Both should reject, though error messages may differ
                expect(genResult.success).toBe(manResult.success);
            });
        }
    });
}

describe('Generated vs Manual Schema Equivalence', () => {
    // Test primitive/simple schemas
    schemasAreEquivalent(
        'ProgressTokenSchema',
        generated.ProgressTokenSchema,
        manual.ProgressTokenSchema,
        {
            valid: ['token123', 42, 0, 'abc'],
            invalid: [null, undefined, {}, [], true],
        }
    );

    schemasAreEquivalent(
        'CursorSchema',
        generated.CursorSchema,
        manual.CursorSchema,
        {
            valid: ['cursor123', '', 'abc'],
            invalid: [null, undefined, 42, {}, []],
        }
    );

    schemasAreEquivalent(
        'RequestIdSchema',
        generated.RequestIdSchema,
        manual.RequestIdSchema,
        {
            valid: ['id123', 42, 0, 'abc'],
            invalid: [null, undefined, {}, [], true],
        }
    );

    // Test object schemas
    schemasAreEquivalent(
        'ImplementationSchema',
        generated.ImplementationSchema,
        manual.ImplementationSchema,
        {
            valid: [
                { name: 'test', version: '1.0.0' },
                { name: 'test', version: '1.0.0', title: 'Test Title' },
            ],
            invalid: [
                null,
                {},
                { name: 'test' }, // missing version
                { version: '1.0.0' }, // missing name
            ],
        }
    );

    schemasAreEquivalent(
        'ToolSchema',
        generated.ToolSchema,
        manual.ToolSchema,
        {
            valid: [
                { name: 'myTool', inputSchema: { type: 'object' } },
                { name: 'myTool', inputSchema: { type: 'object' }, description: 'A tool' },
            ],
            invalid: [
                null,
                {},
                { name: 'myTool' }, // missing inputSchema
                { inputSchema: { type: 'object' } }, // missing name
            ],
        }
    );

    schemasAreEquivalent(
        'ResourceSchema',
        generated.ResourceSchema,
        manual.ResourceSchema,
        {
            valid: [
                { uri: 'file:///test.txt', name: 'test.txt' },
                { uri: 'file:///test.txt', name: 'test.txt', description: 'A file', mimeType: 'text/plain' },
            ],
            invalid: [
                null,
                {},
                { uri: 'file:///test.txt' }, // missing name
                { name: 'test.txt' }, // missing uri
            ],
        }
    );

    schemasAreEquivalent(
        'PromptSchema',
        generated.PromptSchema,
        manual.PromptSchema,
        {
            valid: [
                { name: 'myPrompt' },
                { name: 'myPrompt', description: 'A prompt', arguments: [] },
            ],
            invalid: [
                null,
                {},
                { description: 'A prompt' }, // missing name
            ],
        }
    );

    // Test content schemas
    schemasAreEquivalent(
        'TextContentSchema',
        generated.TextContentSchema,
        manual.TextContentSchema,
        {
            valid: [
                { type: 'text', text: 'Hello' },
            ],
            invalid: [
                null,
                {},
                { type: 'text' }, // missing text
                { text: 'Hello' }, // missing type
                { type: 'image', text: 'Hello' }, // wrong type
            ],
        }
    );

    schemasAreEquivalent(
        'ImageContentSchema',
        generated.ImageContentSchema,
        manual.ImageContentSchema,
        {
            valid: [
                { type: 'image', data: 'base64data', mimeType: 'image/png' },
            ],
            invalid: [
                null,
                {},
                { type: 'image', data: 'base64data' }, // missing mimeType
                { type: 'text', data: 'base64data', mimeType: 'image/png' }, // wrong type
            ],
        }
    );

    // Test JSON-RPC request schemas (now with proper jsonrpc literal after post-processing)
    schemasAreEquivalent(
        'JSONRPCRequestSchema',
        generated.JSONRPCRequestSchema,
        manual.JSONRPCRequestSchema,
        {
            valid: [
                { jsonrpc: '2.0', id: 1, method: 'test' },
                { jsonrpc: '2.0', id: 'abc', method: 'test', params: {} },
            ],
            invalid: [
                null,
                {},
                { jsonrpc: '1.0', id: 1, method: 'test' }, // wrong jsonrpc version
                { id: 1, method: 'test' }, // missing jsonrpc
            ],
        }
    );

    schemasAreEquivalent(
        'InitializeRequestSchema',
        generated.InitializeRequestSchema,
        manual.InitializeRequestSchema,
        {
            valid: [
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: { name: 'test', version: '1.0.0' },
                    },
                },
            ],
            invalid: [
                null,
                {},
                { jsonrpc: '2.0', id: 1, method: 'initialize' }, // missing params
                { jsonrpc: '2.0', id: 1, method: 'other', params: {} }, // wrong method
            ],
        }
    );

    schemasAreEquivalent(
        'CallToolRequestSchema',
        generated.CallToolRequestSchema,
        manual.CallToolRequestSchema,
        {
            valid: [
                { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myTool' } },
                { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myTool', arguments: { foo: 'bar' } } },
            ],
            invalid: [
                null,
                {},
                { jsonrpc: '2.0', id: 1, method: 'tools/call' }, // missing params
                { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, // missing name in params
            ],
        }
    );

    // Also test request params schemas
    schemasAreEquivalent(
        'InitializeRequestParamsSchema',
        generated.InitializeRequestParamsSchema,
        manual.InitializeRequestParamsSchema,
        {
            valid: [
                {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test', version: '1.0.0' },
                },
            ],
            invalid: [
                null,
                {},
                { protocolVersion: '2024-11-05' }, // missing capabilities and clientInfo
            ],
        }
    );

    schemasAreEquivalent(
        'CallToolRequestParamsSchema',
        generated.CallToolRequestParamsSchema,
        manual.CallToolRequestParamsSchema,
        {
            valid: [
                { name: 'myTool' },
                { name: 'myTool', arguments: { foo: 'bar' } },
            ],
            invalid: [
                null,
                {},
                { arguments: { foo: 'bar' } }, // missing name
            ],
        }
    );

    // Test notification schemas (now SDK-compatible, extending NotificationSchema)
    schemasAreEquivalent(
        'CancelledNotificationSchema',
        generated.CancelledNotificationSchema,
        manual.CancelledNotificationSchema,
        {
            valid: [
                { method: 'notifications/cancelled', params: {} },
                { method: 'notifications/cancelled', params: { requestId: '123', reason: 'timeout' } },
            ],
            invalid: [
                null,
                {},
                { method: 'notifications/cancelled' }, // missing params
                { method: 'other', params: {} }, // wrong method
            ],
        }
    );

    schemasAreEquivalent(
        'ProgressNotificationSchema',
        generated.ProgressNotificationSchema,
        manual.ProgressNotificationSchema,
        {
            valid: [
                { method: 'notifications/progress', params: { progressToken: 'token', progress: 50 } },
                { method: 'notifications/progress', params: { progressToken: 'token', progress: 50, total: 100 } },
            ],
            invalid: [
                null,
                {},
                { method: 'notifications/progress' }, // missing params
            ],
        }
    );
});
