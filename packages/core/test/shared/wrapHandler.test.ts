import { describe, expect, it } from 'vitest';

import { Protocol } from '../../src/shared/protocol.js';
import type { BaseContext, JSONRPCRequest, Result } from '../../src/exports/public/index.js';

class TestProtocol extends Protocol<BaseContext> {
    protected buildContext(ctx: BaseContext): BaseContext {
        return ctx;
    }
    protected assertCapabilityForMethod(): void {}
    protected assertNotificationCapability(): void {}
    protected assertRequestHandlerCapability(): void {}
    protected assertTaskCapability(): void {}
    protected assertTaskHandlerCapability(): void {}
}

describe('Protocol._wrapHandler', () => {
    it('routes setRequestHandler registration through _wrapHandler', () => {
        const seen: string[] = [];
        class SpyProtocol extends TestProtocol {
            protected override _wrapHandler(
                method: string,
                handler: (request: JSONRPCRequest, ctx: BaseContext) => Promise<Result>
            ): (request: JSONRPCRequest, ctx: BaseContext) => Promise<Result> {
                seen.push(method);
                return handler;
            }
        }
        const p = new SpyProtocol();
        seen.length = 0;
        p.setRequestHandler('tools/list', () => ({ tools: [] }));
        p.setRequestHandler('resources/list', () => ({ resources: [] }));
        expect(seen).toEqual(['tools/list', 'resources/list']);
    });
});
