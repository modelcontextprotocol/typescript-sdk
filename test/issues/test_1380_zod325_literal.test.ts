import { Client } from '../../src/client/index.js';
import { Server } from '../../src/server/index.js';
import type { AnyObjectSchema, AnySchema } from '../../src/server/zod-compat.js';
import { getLiteralValue } from '../../src/server/zod-compat.js';

function requestSchemaWithValuesLiteral(method: string): AnyObjectSchema {
    return {
        _zod: {
            def: {
                type: 'object',
                shape: {
                    method: {
                        _zod: {
                            def: {
                                type: 'literal',
                                values: [method]
                            }
                        }
                    }
                }
            }
        }
    } as unknown as AnyObjectSchema;
}

describe('Issue #1380: Zod 3.25.x v4 literal value shape', () => {
    test('extracts literal values stored in _zod.def.values', () => {
        const methodSchema = {
            _zod: {
                def: {
                    type: 'literal',
                    values: ['ping']
                }
            }
        } as unknown as AnySchema;

        expect(getLiteralValue(methodSchema)).toBe('ping');
    });

    test('registers server request handlers when the method literal uses _zod.def.values', () => {
        const server = new Server(
            { name: 'test server', version: '1.0' },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        expect(() => {
            server.setRequestHandler(requestSchemaWithValuesLiteral('tools/call'), () => ({
                content: []
            }));
        }).not.toThrow();
    });

    test('registers client request handlers when the method literal uses _zod.def.values', () => {
        const client = new Client(
            { name: 'test client', version: '1.0' },
            {
                capabilities: {
                    elicitation: {}
                }
            }
        );

        expect(() => {
            client.setRequestHandler(requestSchemaWithValuesLiteral('elicitation/create'), () => ({
                action: 'cancel'
            }));
        }).not.toThrow();
    });
});
