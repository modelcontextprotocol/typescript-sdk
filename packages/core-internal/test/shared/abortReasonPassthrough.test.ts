import { describe, expect, it, vi } from 'vitest';

import type { BaseContext } from '../../src/shared/protocol';
import { Protocol } from '../../src/shared/protocol';
import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors';
import { InMemoryTransport } from '../../src/util/inMemory';

class TestProtocolImpl extends Protocol<BaseContext> {
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
}

/**
 * Pins the abort-reason behavior the branding changeset announces: an
 * `SdkError` used as an abort reason is rethrown as-is — including one
 * constructed by a foreign bundled copy of the SDK, which only matches
 * `reason instanceof SdkError` through the cross-bundle brand.
 */
describe('request() abort-reason passthrough', () => {
    async function connectedProtocol(): Promise<TestProtocolImpl> {
        const protocol = new TestProtocolImpl();
        const [transport] = InMemoryTransport.createLinkedPair();
        await protocol.connect(transport);
        return protocol;
    }

    it('rethrows a same-bundle SdkError abort reason as the same object', async () => {
        const protocol = await connectedProtocol();
        const reason = new SdkError(SdkErrorCode.ConnectionClosed, 'caller closed');
        const controller = new AbortController();
        controller.abort(reason);

        await expect(protocol.request({ method: 'ping' }, { signal: controller.signal })).rejects.toBe(reason);
    });

    it('rethrows a foreign-bundle SdkError abort reason as the same object (brand-matched)', async () => {
        vi.resetModules();
        const foreign = await import('../../src/errors/sdkErrors');
        expect(foreign.SdkError).not.toBe(SdkError);

        const protocol = await connectedProtocol();
        const reason = new foreign.SdkError(foreign.SdkErrorCode.ConnectionClosed, 'foreign caller closed');
        const controller = new AbortController();
        controller.abort(reason);

        await expect(protocol.request({ method: 'ping' }, { signal: controller.signal })).rejects.toBe(reason);
    });

    it('wraps a non-SdkError abort reason in SdkError(RequestTimeout)', async () => {
        const protocol = await connectedProtocol();
        const controller = new AbortController();
        controller.abort(new Error('plain'));

        const rejection = await protocol.request({ method: 'ping' }, { signal: controller.signal }).then(
            () => {
                throw new Error('request unexpectedly resolved');
            },
            (e: unknown) => e
        );
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
    });
});
