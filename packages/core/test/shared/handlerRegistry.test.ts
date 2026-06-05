import { describe, it, expect } from 'vitest';
import type { JSONRPCNotification, JSONRPCRequest, Result } from '../../src/types/index.js';
import type { BaseContext } from '../../src/shared/protocol.js';
import { HandlerRegistry } from '../../src/shared/handlerRegistry.js';

describe('HandlerRegistry', () => {
    describe('request handlers', () => {
        it('stores and retrieves a request handler', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            registry.setRequestHandler('tools/call', handler);
            expect(registry.getRequestHandler('tools/call')).toBe(handler);
        });

        it('returns undefined for unregistered method', () => {
            const registry = new HandlerRegistry<BaseContext>();
            expect(registry.getRequestHandler('tools/call')).toBeUndefined();
        });

        it('overwrites a handler for the same method', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler1 = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            const handler2 = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({ changed: true });
            registry.setRequestHandler('tools/call', handler1);
            registry.setRequestHandler('tools/call', handler2);
            expect(registry.getRequestHandler('tools/call')).toBe(handler2);
        });

        it('removes a handler', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            registry.setRequestHandler('tools/call', handler);
            registry.removeRequestHandler('tools/call');
            expect(registry.getRequestHandler('tools/call')).toBeUndefined();
        });

        it('reports whether a handler exists', () => {
            const registry = new HandlerRegistry<BaseContext>();
            expect(registry.hasRequestHandler('tools/call')).toBe(false);
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            registry.setRequestHandler('tools/call', handler);
            expect(registry.hasRequestHandler('tools/call')).toBe(true);
        });
    });

    describe('notification handlers', () => {
        it('stores and retrieves a notification handler', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_n: JSONRPCNotification): Promise<void> => {};
            registry.setNotificationHandler('notifications/cancelled', handler);
            expect(registry.getNotificationHandler('notifications/cancelled')).toBe(handler);
        });

        it('returns undefined for unregistered notification', () => {
            const registry = new HandlerRegistry<BaseContext>();
            expect(registry.getNotificationHandler('notifications/cancelled')).toBeUndefined();
        });

        it('removes a notification handler', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_n: JSONRPCNotification): Promise<void> => {};
            registry.setNotificationHandler('notifications/cancelled', handler);
            registry.removeNotificationHandler('notifications/cancelled');
            expect(registry.getNotificationHandler('notifications/cancelled')).toBeUndefined();
        });
    });

    describe('sharing', () => {
        it('two consumers see the same handler when sharing a registry', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            registry.setRequestHandler('tools/list', handler);
            const fromConsumer1 = registry.getRequestHandler('tools/list');
            const fromConsumer2 = registry.getRequestHandler('tools/list');
            expect(fromConsumer1).toBe(fromConsumer2);
            expect(fromConsumer1).toBe(handler);
        });

        it('mutations by one consumer are visible to another', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            registry.setRequestHandler('tools/call', handler);
            expect(registry.getRequestHandler('tools/call')).toBe(handler);
            registry.removeRequestHandler('tools/call');
            expect(registry.getRequestHandler('tools/call')).toBeUndefined();
        });
    });
});
