import { describe, expect, it, vi } from 'vitest';
import { Client } from '../../src/client/client.js';

describe('callTool v1-compat overload dispatch', () => {
    function makeClient() {
        const client = new Client({ name: 't', version: '1.0.0' }, { capabilities: {} });
        const spy = vi
            .spyOn(client as unknown as { _requestWithSchema: (...a: unknown[]) => Promise<unknown> }, '_requestWithSchema')
            .mockResolvedValue({ content: [] });
        return { client, spy };
    }

    it('callTool(params, undefined, options) preserves options (v1: optional resultSchema)', async () => {
        const { client, spy } = makeClient();
        const opts = { timeout: 5000 };
        await client.callTool({ name: 'x', arguments: {} }, undefined, opts);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[2]).toBe(opts);
    });

    it('callTool(params, schema, options) preserves options', async () => {
        const { client, spy } = makeClient();
        const opts = { timeout: 5000 };
        const schema = { parse: (x: unknown) => x };
        await client.callTool({ name: 'x', arguments: {} }, schema, opts);
        expect(spy.mock.calls[0]?.[2]).toBe(opts);
    });

    it('callTool(params, options) — 2-arg form still works', async () => {
        const { client, spy } = makeClient();
        const opts = { timeout: 5000 };
        await client.callTool({ name: 'x', arguments: {} }, opts);
        expect(spy.mock.calls[0]?.[2]).toBe(opts);
    });

    it('callTool(params) — no options', async () => {
        const { client, spy } = makeClient();
        await client.callTool({ name: 'x', arguments: {} });
        expect(spy.mock.calls[0]?.[2]).toBeUndefined();
    });
});
