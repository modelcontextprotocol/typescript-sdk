import { describe, expect, it } from 'vitest';

import { Protocol } from '../../src/shared/protocol.js';
import { HandlerRegistry } from '../../src/shared/handlerRegistry.js';
import type { BaseContext, JSONRPCRequest, Result } from '../../src/exports/public/index.js';

class TestProtocol extends Protocol<BaseContext> {
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}

    constructor(registry: HandlerRegistry<BaseContext, any>) {
        super(registry);
    }
}

describe('HandlerRegistry wrapHandler callback', () => {
    it('routes setRequestHandler registration through wrapHandler callback', () => {
        const seen: string[] = [];
        const registry = new HandlerRegistry<BaseContext, any>({
            wrapHandler: (method: string, handler: (request: JSONRPCRequest, ctx: BaseContext) => Promise<Result>) => {
                seen.push(method);
                return handler;
            }
        });
        const p = new TestProtocol(registry);
        seen.length = 0;
        p.setRequestHandler('tools/list', () => ({ tools: [] }));
        p.setRequestHandler('resources/list', () => ({ resources: [] }));
        expect(seen).toEqual(['tools/list', 'resources/list']);
    });
});
