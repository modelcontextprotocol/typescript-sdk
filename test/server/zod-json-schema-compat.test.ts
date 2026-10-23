import { describe, expect, it } from 'vitest';
import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';

import { Client } from '../../src/client/index.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { McpServer } from '../../src/server/mcp.js';
import { toJsonSchemaCompat } from '../../src/server/zod-json-schema-compat.js';
import { ListToolsResultSchema } from '../../src/types.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

describe('toJsonSchemaCompat dialect selection (Zod v4)', () => {
    const schema = z4.object({ value: z4.string() });

    it('defaults to JSON Schema 2020-12 when no target is given', () => {
        // Tool.outputSchema in spec.types.ts states it "Defaults to JSON Schema
        // 2020-12 when no explicit $schema is provided", and Zod v4's own
        // toJSONSchema default target is draft-2020-12.
        expect(toJsonSchemaCompat(schema)['$schema']).toBe(DRAFT_2020_12);
    });

    it('still honours an explicit draft-7 target', () => {
        expect(toJsonSchemaCompat(schema, { target: 'draft-7' })['$schema']).toBe(DRAFT_07);
        expect(toJsonSchemaCompat(schema, { target: 'jsonSchema7' })['$schema']).toBe(DRAFT_07);
    });

    it('honours an explicit 2020-12 target', () => {
        expect(toJsonSchemaCompat(schema, { target: 'draft-2020-12' })['$schema']).toBe(DRAFT_2020_12);
        expect(toJsonSchemaCompat(schema, { target: 'jsonSchema2019-09' })['$schema']).toBe(DRAFT_2020_12);
    });

    it('falls back to 2020-12 for an unrecognised target', () => {
        // Unreachable through the CommonOpts type, but reachable from JavaScript
        // callers; the fallback should agree with the documented default rather
        // than silently downgrading the dialect.
        const opts = { target: 'openApi3' } as unknown as Parameters<typeof toJsonSchemaCompat>[1];
        expect(toJsonSchemaCompat(schema, opts)['$schema']).toBe(DRAFT_2020_12);
    });
});

describe('toJsonSchemaCompat dialect selection (Zod v3)', () => {
    it('remains on draft-07, which the vendored converter cannot change', () => {
        // The v3 branch delegates to zod-to-json-schema, whose targets are
        // jsonSchema7 / jsonSchema2019-09 / openApi3 — it has no 2020-12 target.
        // Documented here so the v3/v4 asymmetry is intentional and visible.
        const schema = z3.object({ value: z3.string() });
        expect(toJsonSchemaCompat(schema)['$schema']).toBe(DRAFT_07);
    });
});

describe('tools/list declared dialect', () => {
    it('advertises 2020-12 for inputSchema and outputSchema built from Zod v4', async () => {
        const mcpServer = new McpServer({ name: 'test server', version: '1.0' });

        mcpServer.registerTool(
            'echo',
            {
                description: 'Echoes its input',
                inputSchema: { value: z4.string() },
                outputSchema: { value: z4.string() }
            },
            async ({ value }) => ({
                content: [{ type: 'text', text: value as string }],
                structuredContent: { value }
            })
        );

        const client = new Client({ name: 'test client', version: '1.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

        const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema);

        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].inputSchema.$schema).toBe(DRAFT_2020_12);
        expect(result.tools[0].outputSchema?.$schema).toBe(DRAFT_2020_12);
    });
});
