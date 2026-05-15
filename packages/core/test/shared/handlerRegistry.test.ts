import { describe, expect, it, vi } from 'vitest';
import type { BaseContext } from '../../src/shared/protocol.js';
import type { RequestHandler } from '../../src/shared/handlerRegistry.js';
import { HandlerRegistry } from '../../src/shared/handlerRegistry.js';
import type { JSONRPCRequest, ServerCapabilities } from '../../src/types/index.js';

function createRegistry(options?: ConstructorParameters<typeof HandlerRegistry<BaseContext, ServerCapabilities>>[0]) {
    return new HandlerRegistry<BaseContext, ServerCapabilities>(options);
}

const noopHandler = async () => ({});

describe('HandlerRegistry', () => {
    it('should register and retrieve a spec request handler', () => {
        const registry = createRegistry();
        registry.setRequestHandler('ping', noopHandler);
        expect(registry.requestHandlers.has('ping')).toBe(true);
    });

    it('should call assertRequestHandlerCapability callback during registration', () => {
        const assertCb = vi.fn();
        const registry = createRegistry({ assertRequestHandlerCapability: assertCb });
        registry.setRequestHandler('ping', noopHandler);
        expect(assertCb).toHaveBeenCalledWith('ping');
    });

    it('should apply wrapHandler callback during registration', () => {
        const wrappedHandler: RequestHandler<BaseContext> = async () => ({ wrapped: true });
        const wrapCb = vi.fn((_method: string, _handler: RequestHandler<BaseContext>) => wrappedHandler);

        const registry = createRegistry({ wrapHandler: wrapCb });
        registry.setRequestHandler('ping', noopHandler);

        expect(wrapCb).toHaveBeenCalledWith('ping', expect.any(Function));
        expect(registry.requestHandlers.get('ping')).toBe(wrappedHandler);
    });

    it('should throw from assertCanSetRequestHandler on duplicate handler', () => {
        const registry = createRegistry();
        registry.setRequestHandler('ping', noopHandler);

        expect(() => registry.assertCanSetRequestHandler('ping')).toThrow('A request handler for ping already exists');
    });

    it('should remove a request handler', () => {
        const registry = createRegistry();
        registry.setRequestHandler('ping', noopHandler);
        expect(registry.requestHandlers.has('ping')).toBe(true);

        registry.removeRequestHandler('ping');
        expect(registry.requestHandlers.has('ping')).toBe(false);
    });

    it('should merge capabilities via registerCapabilities', () => {
        const registry = createRegistry({ capabilities: { tools: {} } });
        registry.registerCapabilities({ logging: {} });

        const caps = registry.getCapabilities();
        expect(caps.tools).toEqual({});
        expect(caps.logging).toEqual({});
    });

    it('should register and retrieve a notification handler', () => {
        const registry = createRegistry();
        const handler = async () => {};
        registry.setNotificationHandler('notifications/cancelled', handler);

        expect(registry.notificationHandlers.has('notifications/cancelled')).toBe(true);
    });

    it('should remove a notification handler', () => {
        const registry = createRegistry();
        registry.setNotificationHandler('notifications/cancelled', async () => {});
        expect(registry.notificationHandlers.has('notifications/cancelled')).toBe(true);

        registry.removeNotificationHandler('notifications/cancelled');
        expect(registry.notificationHandlers.has('notifications/cancelled')).toBe(false);
    });

    it('should store and retrieve fallbackRequestHandler', () => {
        const registry = createRegistry();
        const fallback: RequestHandler<BaseContext> = async (_req: JSONRPCRequest) => ({ fallback: true });

        registry.fallbackRequestHandler = fallback;
        expect(registry.fallbackRequestHandler).toBe(fallback);
    });

    it('should return initial capabilities via getCapabilities', () => {
        const registry = createRegistry({ capabilities: { prompts: {} } });
        const caps = registry.getCapabilities();
        expect(caps.prompts).toEqual({});
    });
});
