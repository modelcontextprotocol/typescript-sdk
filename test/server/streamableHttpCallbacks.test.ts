import { describe, expect, it, vi } from 'vitest';
import { StreamableHTTPServerTransport } from '../../src/server/streamableHttp.js';
import type { Transport } from '../../src/shared/transport.js';

describe('StreamableHTTPServerTransport callbacks', () => {
    it('allows callbacks to be installed and cleared through the transport interface', async () => {
        const nodeTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const transport: Transport = nodeTransport;
        const onclose = vi.fn();
        const onerror = vi.fn();
        const onmessage = vi.fn();

        try {
            expect(transport.sessionId).toBeUndefined();
            expect(transport.onclose).toBeUndefined();
            expect(transport.onerror).toBeUndefined();
            expect(transport.onmessage).toBeUndefined();

            transport.onclose = onclose;
            transport.onerror = onerror;
            transport.onmessage = onmessage;
            expect(nodeTransport.onclose).toBe(onclose);
            expect(nodeTransport.onerror).toBe(onerror);
            expect(nodeTransport.onmessage).toBe(onmessage);

            transport.onclose = undefined;
            transport.onerror = undefined;
            transport.onmessage = undefined;
            expect(nodeTransport.onclose).toBeUndefined();
            expect(nodeTransport.onerror).toBeUndefined();
            expect(nodeTransport.onmessage).toBeUndefined();
        } finally {
            await transport.close();
        }
        expect(onclose).not.toHaveBeenCalled();
        expect(onerror).not.toHaveBeenCalled();
        expect(onmessage).not.toHaveBeenCalled();
    });
});
