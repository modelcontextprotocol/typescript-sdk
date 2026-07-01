import { describe, expect, it, vi } from 'vitest';

import { AjvJsonSchemaValidator } from '../../src/validators/ajvProvider';
import { CfWorkerJsonSchemaValidator } from '../../src/validators/cfWorkerProvider';
import { resolveExternalSchemaRefs } from '../../src/validators/externalRefResolver';
import { assertSchemaSafeToCompile } from '../../src/validators/schemaBounds';
import type { JsonSchemaType } from '../../src/validators/types';

/** Build a `fetch` stub that serves a fixed map of URL -> JSON Schema document. */
function fetchStub(docs: Record<string, unknown>, init?: { status?: number; contentLength?: string }): typeof globalThis.fetch {
    return vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const doc = docs[url];
        if (doc === undefined) {
            return new Response('not found', { status: 404 });
        }
        const headers = new Headers();
        if (init?.contentLength) {
            headers.set('content-length', init.contentLength);
        }
        return new Response(JSON.stringify(doc), { status: init?.status ?? 200, headers });
    }) as unknown as typeof globalThis.fetch;
}

describe('resolveExternalSchemaRefs', () => {
    it('is exported from the curated public API', async () => {
        const publicApi = await import('../../src/exports/public/index.js');

        expect(publicApi.resolveExternalSchemaRefs).toBe(resolveExternalSchemaRefs);
        expect(publicApi.MCP_DEFAULT_SCHEMA_DIALECT).toBe('2020-12');
    });

    it('returns the schema unchanged when there are no external refs', async () => {
        const schema: JsonSchemaType = { type: 'object', properties: { a: { type: 'string' } } };
        const fetchImpl = vi.fn();
        const out = await resolveExternalSchemaRefs(schema, { fetch: fetchImpl as unknown as typeof fetch });
        expect(out).toEqual(schema);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('bundles an external $ref and rewrites it to a same-document pointer', async () => {
        const schema: JsonSchemaType = {
            type: 'object',
            properties: { forecast: { $ref: 'https://schemas.example.com/forecast.json' } },
            required: ['forecast']
        };
        const fetchImpl = fetchStub({
            'https://schemas.example.com/forecast.json': { type: 'array', items: { type: 'number' } }
        });

        const resolved = await resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchImpl });

        // The consuming ref is now local, and the document is flattened under $defs.
        const props = (resolved as Record<string, unknown>).properties as Record<string, { $ref: string }>;
        expect(props.forecast?.$ref).toMatch(/^#\/\$defs\/__externalRef_0$/);
        const defs = (resolved as Record<string, unknown>).$defs as Record<string, { type: string; items: unknown }>;
        expect(defs.__externalRef_0).toEqual({ type: 'array', items: { type: 'number' } });

        // The result is fully local: the default safety guard accepts it and it compiles.
        expect(() => assertSchemaSafeToCompile(resolved)).not.toThrow();
    });

    it('allocates external $defs slots without overwriting existing root definitions', async () => {
        const schema: JsonSchemaType = {
            $ref: 'https://schemas.example.com/forecast.json',
            $defs: { __externalRef_0: { type: 'number' } }
        };
        const fetchImpl = fetchStub({
            'https://schemas.example.com/forecast.json': { type: 'string' }
        });

        const resolved = await resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchImpl });

        expect(resolved).toEqual({
            $ref: '#/$defs/__externalRef_1',
            $defs: {
                __externalRef_0: { type: 'number' },
                __externalRef_1: { type: 'string' }
            }
        });
    });

    it('matches allowlist hosts case-insensitively', async () => {
        const schema: JsonSchemaType = { $ref: 'https://Schemas.Example.com/forecast.json' };
        const fetchImpl = fetchStub({
            'https://schemas.example.com/forecast.json': { type: 'array', items: { type: 'number' } }
        });

        const resolved = await resolveExternalSchemaRefs(schema, { allowlist: ['Schemas.Example.com'], fetch: fetchImpl });

        expect(resolved).toEqual({
            $ref: '#/$defs/__externalRef_0',
            $defs: { __externalRef_0: { type: 'array', items: { type: 'number' } } }
        });
    });

    it('matches allowlist hosts with a trailing DNS root dot', async () => {
        const schema: JsonSchemaType = { $ref: 'https://schemas.example.com./forecast.json' };
        const fetchImpl = fetchStub({
            'https://schemas.example.com./forecast.json': { type: 'string' }
        });

        const resolved = await resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchImpl });

        expect(resolved).toEqual({
            $ref: '#/$defs/__externalRef_0',
            $defs: { __externalRef_0: { type: 'string' } }
        });
    });

    it.each([
        ['AJV', () => new AjvJsonSchemaValidator()],
        ['CfWorker', () => new CfWorkerJsonSchemaValidator()]
    ] as const)('produces a schema that validates correctly with %s (no network at validation time)', async (_name, make) => {
        const schema: JsonSchemaType = {
            type: 'object',
            properties: { forecast: { $ref: 'https://schemas.example.com/forecast.json#/$defs/hourly' } },
            required: ['forecast']
        };
        const fetchImpl = fetchStub({
            'https://schemas.example.com/forecast.json': {
                $defs: { hourly: { type: 'array', items: { type: 'number' } } }
            }
        });

        const resolved = await resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchImpl });

        const validate = make().getValidator(resolved as JsonSchemaType);
        expect(validate({ forecast: [1, 2, 3] }).valid).toBe(true);
        expect(validate({ forecast: ['x'] }).valid).toBe(false);
    });

    it('resolves transitive external refs (a fetched doc that references another doc)', async () => {
        const schema: JsonSchemaType = { $ref: 'https://schemas.example.com/a.json' };
        const fetchImpl = fetchStub({
            'https://schemas.example.com/a.json': {
                type: 'object',
                properties: { b: { $ref: 'https://schemas.example.com/b.json' } },
                required: ['b']
            },
            'https://schemas.example.com/b.json': { type: 'number' }
        });

        const resolved = await resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchImpl });

        expect(() => assertSchemaSafeToCompile(resolved)).not.toThrow();
        const validate = new AjvJsonSchemaValidator().getValidator(resolved as JsonSchemaType);
        expect(validate({ b: 42 }).valid).toBe(true);
        expect(validate({ b: 'no' }).valid).toBe(false);
    });

    it('resolves relative refs inside fetched documents against the containing document URL', async () => {
        const schema: JsonSchemaType = { $ref: 'https://schemas.example.com/models/person.json' };
        const fetchImpl = fetchStub({
            'https://schemas.example.com/models/person.json': {
                type: 'object',
                properties: {
                    address: { $ref: '../common/address.json#/$defs/address' }
                },
                required: ['address']
            },
            'https://schemas.example.com/common/address.json': {
                $defs: {
                    address: {
                        type: 'object',
                        properties: { city: { type: 'string' } },
                        required: ['city']
                    }
                }
            }
        });

        const resolved = await resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchImpl });

        expect(() => assertSchemaSafeToCompile(resolved)).not.toThrow();
        expect(fetchImpl).toHaveBeenCalledWith('https://schemas.example.com/common/address.json', expect.anything());
        const validate = new AjvJsonSchemaValidator().getValidator(resolved as JsonSchemaType);
        expect(validate({ address: { city: 'Paris' } }).valid).toBe(true);
        expect(validate({ address: {} }).valid).toBe(false);
    });

    it('resolves relative refs inside fetched documents against the declared canonical $id', async () => {
        const schema: JsonSchemaType = { $ref: 'https://mirror.example.com/v2/person.json' };
        const fetchImpl = fetchStub({
            'https://mirror.example.com/v2/person.json': {
                $id: 'https://schemas.example.com/person.json',
                type: 'object',
                properties: {
                    address: { $ref: 'address.json#/$defs/address' }
                },
                required: ['address']
            },
            'https://schemas.example.com/address.json': {
                $defs: {
                    address: {
                        type: 'object',
                        properties: { city: { type: 'string' } },
                        required: ['city']
                    }
                }
            }
        });

        const resolved = await resolveExternalSchemaRefs(schema, {
            allowlist: ['mirror.example.com', 'schemas.example.com'],
            fetch: fetchImpl
        });

        expect(fetchImpl).toHaveBeenCalledWith('https://schemas.example.com/address.json', expect.anything());
        expect(() => assertSchemaSafeToCompile(resolved)).not.toThrow();
        const validate = new AjvJsonSchemaValidator().getValidator(resolved as JsonSchemaType);
        expect(validate({ address: { city: 'Paris' } }).valid).toBe(true);
        expect(validate({ address: {} }).valid).toBe(false);
    });

    it('does not dereference $ref-shaped data inside data-valued JSON Schema keywords', async () => {
        const schema: JsonSchemaType = {
            type: 'object',
            properties: {
                payload: {
                    type: 'object',
                    default: { $ref: 'https://data.example/default-value' },
                    examples: [{ $ref: 'https://data.example/example-value' }]
                }
            }
        };
        const fetchImpl = vi.fn();

        const resolved = await resolveExternalSchemaRefs(schema, {
            allowlist: ['data.example'],
            fetch: fetchImpl as unknown as typeof fetch
        });

        expect(resolved).toEqual(schema);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('calls onDereference for each fetched URI (observability)', async () => {
        const schema: JsonSchemaType = { $ref: 'https://schemas.example.com/a.json' };
        const fetchImpl = fetchStub({ 'https://schemas.example.com/a.json': { type: 'string' } });
        const seen: string[] = [];

        await resolveExternalSchemaRefs(schema, {
            allowlist: ['schemas.example.com'],
            fetch: fetchImpl,
            onDereference: uri => seen.push(uri)
        });

        expect(seen).toEqual(['https://schemas.example.com/a.json']);
    });

    describe('security: host / protocol restrictions', () => {
        it('rejects a host not in the allowlist', async () => {
            const schema: JsonSchemaType = { $ref: 'https://evil.example/x.json' };
            await expect(resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchStub({}) })).rejects.toThrow(
                /not in the allowlist/i
            );
        });

        it.each([
            'https://localhost/x.json',
            'https://localhost./x.json',
            'https://127.0.0.1/x.json',
            'https://10.0.0.5/x.json',
            'https://169.254.169.254/x.json',
            'https://metadata.google.internal./computeMetadata/v1',
            'https://[::1]/x.json',
            'https://[fd00::1]/x.json',
            'https://[fe80::1]/x.json',
            'https://[::ffff:127.0.0.1]/x.json'
        ])('rejects loopback/link-local/private target %s when no allowlist is given', async uri => {
            await expect(resolveExternalSchemaRefs({ $ref: uri } as JsonSchemaType, { fetch: fetchStub({}) })).rejects.toThrow(
                /loopback\/link-local\/private/i
            );
        });

        it('allows public DNS hosts that start with IPv6 private-range prefixes', async () => {
            const fetchImpl = fetchStub({ 'https://fcc.gov/schema.json': { type: 'string' } });
            const resolved = await resolveExternalSchemaRefs({ $ref: 'https://fcc.gov/schema.json' } as JsonSchemaType, {
                fetch: fetchImpl
            });

            expect(resolved).toEqual({ $ref: '#/$defs/__externalRef_0', $defs: { __externalRef_0: { type: 'string' } } });
        });

        it('matches IPv6 literal allowlist entries without URL brackets', async () => {
            const fetchImpl = fetchStub({ 'https://[2001:db8::1]/schema.json': { type: 'string' } });
            const resolved = await resolveExternalSchemaRefs({ $ref: 'https://[2001:db8::1]/schema.json' } as JsonSchemaType, {
                allowlist: ['2001:db8::1'],
                fetch: fetchImpl
            });

            expect(resolved).toEqual({ $ref: '#/$defs/__externalRef_0', $defs: { __externalRef_0: { type: 'string' } } });
        });

        it('rejects a disallowed protocol (http when only https is allowed)', async () => {
            await expect(
                resolveExternalSchemaRefs({ $ref: 'http://schemas.example.com/x.json' } as JsonSchemaType, {
                    allowlist: ['schemas.example.com'],
                    fetch: fetchStub({})
                })
            ).rejects.toThrow(/protocol "http:" is not allowed/i);
        });
    });

    describe('bounds and fail-closed behaviour', () => {
        it('rejects when the fetch fails (fail-closed, not silent pass)', async () => {
            const schema: JsonSchemaType = { $ref: 'https://schemas.example.com/missing.json' };
            await expect(resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchStub({}) })).rejects.toThrow(
                /HTTP 404/
            );
        });

        it('rejects a response exceeding the byte limit (declared content-length)', async () => {
            const schema: JsonSchemaType = { $ref: 'https://schemas.example.com/big.json' };
            const fetchImpl = fetchStub({ 'https://schemas.example.com/big.json': { type: 'string' } }, { contentLength: '999999' });
            await expect(
                resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchImpl, maxBytes: 10 })
            ).rejects.toThrow(/exceeds max 10 bytes/i);
        });

        it('rejects when the document budget is exceeded', async () => {
            const schema: JsonSchemaType = {
                allOf: [{ $ref: 'https://schemas.example.com/a.json' }, { $ref: 'https://schemas.example.com/b.json' }]
            };
            const fetchImpl = fetchStub({
                'https://schemas.example.com/a.json': { type: 'object' },
                'https://schemas.example.com/b.json': { type: 'object' }
            });
            await expect(
                resolveExternalSchemaRefs(schema, { allowlist: ['schemas.example.com'], fetch: fetchImpl, maxDocuments: 1 })
            ).rejects.toThrow(/more than 1 external schema documents/i);
        });

        it('rejects an external $anchor fragment (unsupported)', async () => {
            const schema: JsonSchemaType = { $ref: 'https://schemas.example.com/a.json#someAnchor' };
            await expect(
                resolveExternalSchemaRefs(schema, {
                    allowlist: ['schemas.example.com'],
                    fetch: fetchStub({ 'https://schemas.example.com/a.json': { type: 'string' } })
                })
            ).rejects.toThrow(/\$anchor.*not supported/i);
        });

        it('rejects a non-JSON response', async () => {
            const badFetch = vi.fn(async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof fetch;
            await expect(
                resolveExternalSchemaRefs({ $ref: 'https://schemas.example.com/a.json' } as JsonSchemaType, {
                    allowlist: ['schemas.example.com'],
                    fetch: badFetch
                })
            ).rejects.toThrow(/not valid JSON/i);
        });
    });
});
