/**
 * Production-catalog cold entry.
 *
 * The fixture is the frozen public 170-tool catalog, not the REA product.
 * Counts and bodies are the contract. Wall time is not.
 */
import { fileURLToPath } from 'node:url';

import type { JSONRPCMessage, JsonSchemaType, jsonSchemaValidator } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';
import { getDefaultEnvironment, StdioClientTransport } from '../../src/client/stdio';
import { addFormats, AjvJsonSchemaValidator } from '../../src/validators/ajv';
import {
    createCatalogSession,
    handleMessage,
    recoveryOutput,
    withChangedBinarySession
} from './fixtures/production-catalog/catalog-session.mjs';
import { loadProductionCatalog } from './fixtures/production-catalog/load-catalog.mjs';

const catalog = loadProductionCatalog();
const binaryTool = catalog.tools.find(tool => tool.name === 'binary_session');
if (binaryTool?.outputSchema === undefined) throw new Error('binary_session output schema missing');
const binaryOutputId = binaryTool.outputSchema.$id;

function recordingEngine() {
    const ajv = new Ajv2020({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
    addFormats(ajv);
    const engine = {
        compiles: 0,
        compile(schema: unknown) {
            engine.compiles += 1;
            return ajv.compile(schema as Parameters<Ajv2020['compile']>[0]);
        },
        getSchema(keyRef: string) {
            return ajv.getSchema(keyRef);
        },
        errorsText(errors?: Parameters<Ajv2020['errorsText']>[0]) {
            return ajv.errorsText(errors);
        }
    };
    return engine;
}

class CountingValidator implements jsonSchemaValidator {
    readonly schemas: JsonSchemaType[] = [];

    constructor(private readonly inner: jsonSchemaValidator) {}

    getValidator<T>(schema: JsonSchemaType) {
        this.schemas.push(schema);
        return this.inner.getValidator<T>(schema);
    }
}

function validatorIndex(client: Client) {
    const cache = (
        client as unknown as {
            _cache: {
                _toolOutputValidatorIndex?: {
                    toolsByName: Map<string, unknown>;
                    byName: Map<string, unknown>;
                };
            };
        }
    )._cache;
    return cache._toolOutputValidatorIndex;
}

interface Harness {
    client: Client;
    session: ReturnType<typeof createCatalogSession>;
    serverTransport: ReturnType<typeof InMemoryTransport.createLinkedPair>[1];
    close: () => Promise<void>;
}

async function connectCatalog(options?: {
    mode?: string;
    validator?: jsonSchemaValidator;
    onChanged?: (error: Error | null, items: unknown[] | null) => void;
}): Promise<Harness> {
    const session = createCatalogSession({
        tools: catalog.tools,
        structuredContent: catalog.structuredContent,
        mode: options?.mode ?? 'call'
    });
    const client = new Client(
        { name: 'production-catalog-client', version: '211240' },
        {
            capabilities: {},
            ...(options?.validator !== undefined && { jsonSchemaValidator: options.validator }),
            ...(options?.onChanged !== undefined && {
                listChanged: { tools: { debounceMs: 0, onChanged: options.onChanged } }
            })
        }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.onmessage = async message => {
        const response = handleMessage(session, message);
        if (response !== undefined) await serverTransport.send(response as JSONRPCMessage);
    };
    await Promise.all([client.connect(clientTransport), serverTransport.start()]);
    return {
        client,
        session,
        serverTransport,
        close: async () => {
            await client.close();
            await clientTransport.close();
            await serverTransport.close();
        }
    };
}

async function waitUntilGone(pid: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
            throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`child ${pid} is still alive`);
}

describe('production catalog cold entry', () => {
    const closers: Array<() => Promise<void>> = [];

    afterEach(async () => {
        while (closers.length > 0) {
            const close = closers.pop();
            if (close !== undefined) await close();
        }
    });

    it('keeps the unmodified 170-tool catalog identity', () => {
        expect(catalog.identity.label).toBe('catalogue-derived fixture, not the REA product');
        expect(catalog.identity.rea.commit).toBe('21650455a9c90a26e725c3505a3c17054cc4516c');
        expect(catalog.identity.rea.license).toBe('MIT');
        expect(catalog.tools).toHaveLength(170);
        expect(new Set(catalog.tools.map(tool => tool.name)).size).toBe(170);
        expect(catalog.tools.reduce((count, tool) => count + (tool.inputSchema ? 1 : 0) + (tool.outputSchema ? 1 : 0), 0)).toBe(340);
        expect(catalog.identity.toolsFile.rawSha256).toBe('b1e3057747a323647e2bf690acb877bd50a109dd0604fa5ae62e0c42d15a1192');
        expect(catalog.identity.toolsFile.documentSha256).toBe('1b182124636ab9236e3224b8c4b6279306cf43be569461943dabf63331878eea');
        expect(catalog.input).toEqual({});
        expect(catalog.structuredContent.result.open).toBe(false);
    });

    it('treats all 340 schemas as meta-valid', () => {
        const ajv = new Ajv2020({ strict: false, validateFormats: false });
        for (const tool of catalog.tools) {
            expect(ajv.validateSchema(tool.inputSchema), tool.name).toBe(true);
            expect(ajv.validateSchema(tool.outputSchema), tool.name).toBe(true);
        }
    });

    it('default Ajv compiles only the called tool and returns the benign body', async () => {
        const harness = await connectCatalog();
        closers.push(harness.close);
        const listed = await harness.client.listTools();
        expect(listed.tools).toHaveLength(170);
        expect(listed.tools.map(tool => tool.name)).toContain('binary_session');
        expect(validatorIndex(harness.client)).toBeUndefined();

        const result = await harness.client.callTool({ name: 'binary_session', arguments: {} });
        expect(result.structuredContent).toEqual(catalog.structuredContent);
        expect(result.content).toEqual([{ type: 'text', text: 'catalogue-derived fixture; no binary was analyzed' }]);
        const index = validatorIndex(harness.client);
        expect(index?.toolsByName.size).toBe(170);
        expect([...index!.byName.keys()]).toEqual(['binary_session']);

        await harness.client.callTool({ name: 'binary_session', arguments: {} });
        expect([...validatorIndex(harness.client)!.byName.keys()]).toEqual(['binary_session']);
    });

    it('default Ajv refuses malformed output and then accepts the valid body', async () => {
        const harness = await connectCatalog({ mode: 'malformed' });
        closers.push(harness.close);
        await harness.client.listTools();
        await expect(harness.client.callTool({ name: 'binary_session', arguments: {} })).rejects.toThrow(
            /Structured content does not match the tool's output schema/
        );
        expect([...validatorIndex(harness.client)!.byName.keys()]).toEqual(['binary_session']);

        const recovered = await harness.client.callTool({ name: 'binary_session', arguments: {} });
        expect(recovered.structuredContent).toEqual(catalog.structuredContent);
        expect([...validatorIndex(harness.client)!.byName.keys()]).toEqual(['binary_session']);
    });

    it('list_changed refresh refuses the previous body and accepts recovery', async () => {
        let resolveChanged: (value: { error: Error | null; count: number | null }) => void = () => {};
        const changed = new Promise<{ error: Error | null; count: number | null }>(resolve => {
            resolveChanged = resolve;
        });
        const harness = await connectCatalog({
            mode: 'schema',
            onChanged(error, items) {
                resolveChanged({ error, count: items?.length ?? null });
            }
        });
        closers.push(harness.close);
        await harness.client.listTools();
        const first = await harness.client.callTool({ name: 'binary_session', arguments: {} });
        expect(first.structuredContent).toEqual(catalog.structuredContent);
        expect([...validatorIndex(harness.client)!.byName.keys()]).toEqual(['binary_session']);

        harness.session.setChanged(true);
        await harness.serverTransport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        const refresh = await changed;
        expect(refresh.error).toBeNull();
        expect(refresh.count).toBe(170);
        const changedTool = withChangedBinarySession(catalog.tools).find(tool => tool.name === 'binary_session');
        const refreshed = await harness.client.listTools();
        expect(refreshed.tools.find(tool => tool.name === 'binary_session')?.outputSchema).toEqual(changedTool?.outputSchema);

        await expect(harness.client.callTool({ name: 'binary_session', arguments: {} })).rejects.toThrow(
            /Structured content does not match the tool's output schema/
        );
        expect([...validatorIndex(harness.client)!.byName.keys()]).toEqual(['binary_session']);
        expect(validatorIndex(harness.client)?.toolsByName.size).toBe(170);

        const recovered = await harness.client.callTool({ name: 'binary_session', arguments: {} });
        expect(recovered.structuredContent).toEqual(recoveryOutput);
        expect([...validatorIndex(harness.client)!.byName.keys()]).toEqual(['binary_session']);
    });

    it('cacheMode refresh drops the memoized validator for a changed schema', async () => {
        const harness = await connectCatalog({ mode: 'schema' });
        closers.push(harness.close);
        await harness.client.listTools();
        await harness.client.callTool({ name: 'binary_session', arguments: {} });
        harness.session.setChanged(true);
        const refreshed = await harness.client.listTools(undefined, { cacheMode: 'refresh' });
        expect(refreshed.tools).toHaveLength(170);
        await expect(harness.client.callTool({ name: 'binary_session', arguments: {} })).rejects.toThrow(
            /Structured content does not match the tool's output schema/
        );
        expect([...validatorIndex(harness.client)!.byName.keys()]).toEqual(['binary_session']);
        const recovered = await harness.client.callTool({ name: 'binary_session', arguments: {} });
        expect(recovered.structuredContent).toEqual(recoveryOutput);
    });

    it('a configured standard Ajv engine compiles only the called output schema', async () => {
        const solo = recordingEngine();
        new AjvJsonSchemaValidator(solo).getValidator(binaryTool.outputSchema as JsonSchemaType);
        const engine = recordingEngine();
        const counting = new CountingValidator(new AjvJsonSchemaValidator(engine));
        const harness = await connectCatalog({ validator: counting });
        closers.push(harness.close);
        await harness.client.listTools();
        expect(counting.schemas).toHaveLength(0);
        expect(engine.compiles).toBe(0);

        const result = await harness.client.callTool({ name: 'binary_session', arguments: {} });
        expect(result.structuredContent).toEqual(catalog.structuredContent);
        expect(counting.schemas).toHaveLength(1);
        expect(counting.schemas[0]?.$id).toBe(binaryOutputId);
        expect(engine.compiles).toBe(solo.compiles);
        expect(engine.compiles).toBeGreaterThan(0);
        expect(engine.compiles).toBeLessThan(170);
        expect([...validatorIndex(harness.client)!.byName.keys()]).toEqual(['binary_session']);

        await harness.client.callTool({ name: 'binary_session', arguments: {} });
        expect(counting.schemas).toHaveLength(1);
        expect(engine.compiles).toBe(solo.compiles);
    });

    it('a configured engine refuses malformed output and reuses the validator on recovery', async () => {
        const engine = recordingEngine();
        const counting = new CountingValidator(new AjvJsonSchemaValidator(engine));
        const harness = await connectCatalog({ mode: 'malformed', validator: counting });
        closers.push(harness.close);
        await harness.client.listTools();
        await expect(harness.client.callTool({ name: 'binary_session', arguments: {} })).rejects.toThrow(
            /Structured content does not match the tool's output schema/
        );
        expect(counting.schemas).toHaveLength(1);
        const compilesAfterRefusal = engine.compiles;
        const recovered = await harness.client.callTool({ name: 'binary_session', arguments: {} });
        expect(recovered.structuredContent).toEqual(catalog.structuredContent);
        expect(counting.schemas).toHaveLength(1);
        expect(engine.compiles).toBe(compilesAfterRefusal);
    });

    it('stdio loopback serves the catalog and the child exits', async () => {
        const fixture = fileURLToPath(new URL('fixtures/production-catalog/catalog-session.mjs', import.meta.url));
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fixture],
            env: { ...getDefaultEnvironment(), FIXTURE_MODE: 'call' },
            stderr: 'pipe'
        });
        const client = new Client({ name: 'production-catalog-stdio', version: '211240' }, { capabilities: {} });
        let stderr = '';
        transport.stderr?.on('data', chunk => {
            stderr += chunk.toString();
        });
        await client.connect(transport);
        const listed = await client.listTools();
        expect(listed.tools).toHaveLength(170);
        const result = await client.callTool({ name: 'binary_session', arguments: {} });
        expect(result.structuredContent).toEqual(catalog.structuredContent);
        expect([...validatorIndex(client)!.byName.keys()]).toEqual(['binary_session']);
        const pid = transport.pid;
        expect(pid).not.toBeNull();
        await client.close();
        await transport.close();
        await waitUntilGone(pid!);
        expect(stderr).toBe('');
    }, 30_000);
});
