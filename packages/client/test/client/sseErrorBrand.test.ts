import { describe, expect, it, vi } from 'vitest';

import { SseError } from '../../src/client/sse';

describe('SseError cross-bundle instanceof', () => {
    it('same-bundle instanceof and fields keep working', () => {
        const err = new SseError(401, 'unauthorized', {} as never);
        expect(err instanceof SseError).toBe(true);
        expect(err instanceof Error).toBe(true);
        expect(err.code).toBe(401);
    });

    it('an instance from a second module copy satisfies instanceof against this copy', async () => {
        vi.resetModules();
        const copy2 = await import('../../src/client/sse');
        expect(copy2.SseError).not.toBe(SseError);
        const foreign = new copy2.SseError(403, 'forbidden', {} as never);
        expect(foreign instanceof SseError).toBe(true);
    });

    it('stays disjoint from the SdkError hierarchy', async () => {
        const { SdkError } = await import('@modelcontextprotocol/core-internal');
        const err = new SseError(500, 'boom', {} as never);
        expect((err as unknown) instanceof SdkError).toBe(false);
    });
});
