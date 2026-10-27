import type { ProtocolInstrumentation as ClientInstrumentation } from '@modelcontextprotocol/client';
import type { ProtocolInstrumentation as ServerInstrumentation } from '@modelcontextprotocol/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ProtocolInstrumentation } from '../src/index';
import { openTelemetry } from '../src/index';

describe('ProtocolInstrumentation', () => {
    it('is accepted wherever the client and server packages take an instrumentation', () => {
        const instrumentation = openTelemetry();
        expectTypeOf(instrumentation).toExtend<ClientInstrumentation>();
        expectTypeOf(instrumentation).toExtend<ServerInstrumentation>();
        expectTypeOf<ClientInstrumentation>().toExtend<ProtocolInstrumentation>();
        expect(typeof instrumentation.send).toBe('function');
        expect(typeof instrumentation.receive).toBe('function');
    });
});
