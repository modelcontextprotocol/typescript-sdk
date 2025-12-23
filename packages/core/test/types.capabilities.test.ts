import { ClientCapabilitiesSchema, InitializeRequestParamsSchema } from '../src/types/types.js';

describe('ClientCapabilitiesSchema backwards compatibility', () => {
    describe('ElicitationCapabilitySchema preprocessing', () => {
        it('should inject form capability when elicitation is an empty object', () => {
            const capabilities = {
                elicitation: {}
            };

            const result = ClientCapabilitiesSchema.parse(capabilities);
            expect(result.elicitation).toBeDefined();
            expect(result.elicitation?.form).toBeDefined();
            expect(result.elicitation?.form).toEqual({});
            expect(result.elicitation?.url).toBeUndefined();
        });

        it('should preserve form capability configuration including applyDefaults', () => {
            const capabilities = {
                elicitation: {
                    form: {
                        applyDefaults: true
                    }
                }
            };

            const result = ClientCapabilitiesSchema.parse(capabilities);
            expect(result.elicitation).toBeDefined();
            expect(result.elicitation?.form).toBeDefined();
            expect(result.elicitation?.form).toEqual({ applyDefaults: true });
            expect(result.elicitation?.url).toBeUndefined();
        });

        it('should not inject form capability when form is explicitly declared', () => {
            const capabilities = {
                elicitation: {
                    form: {}
                }
            };

            const result = ClientCapabilitiesSchema.parse(capabilities);
            expect(result.elicitation).toBeDefined();
            expect(result.elicitation?.form).toBeDefined();
            expect(result.elicitation?.form).toEqual({});
            expect(result.elicitation?.url).toBeUndefined();
        });

        it('should not inject form capability when url is explicitly declared', () => {
            const capabilities = {
                elicitation: {
                    url: {}
                }
            };

            const result = ClientCapabilitiesSchema.parse(capabilities);
            expect(result.elicitation).toBeDefined();
            expect(result.elicitation?.url).toBeDefined();
            expect(result.elicitation?.url).toEqual({});
            expect(result.elicitation?.form).toBeUndefined();
        });

        it('should not inject form capability when both form and url are explicitly declared', () => {
            const capabilities = {
                elicitation: {
                    form: {},
                    url: {}
                }
            };

            const result = ClientCapabilitiesSchema.parse(capabilities);
            expect(result.elicitation).toBeDefined();
            expect(result.elicitation?.form).toBeDefined();
            expect(result.elicitation?.url).toBeDefined();
            expect(result.elicitation?.form).toEqual({});
            expect(result.elicitation?.url).toEqual({});
        });

        it('should not inject form capability when elicitation is undefined', () => {
            const capabilities = {};

            const result = ClientCapabilitiesSchema.parse(capabilities);
            // When elicitation is not provided, it should remain undefined
            expect(result.elicitation).toBeUndefined();
        });

        it('should work within InitializeRequestParamsSchema context', () => {
            const initializeParams = {
                protocolVersion: '2025-11-25',
                capabilities: {
                    elicitation: {}
                },
                clientInfo: {
                    name: 'test client',
                    version: '1.0'
                }
            };

            const result = InitializeRequestParamsSchema.parse(initializeParams);
            expect(result.capabilities.elicitation).toBeDefined();
            expect(result.capabilities.elicitation?.form).toBeDefined();
            expect(result.capabilities.elicitation?.form).toEqual({});
        });
    });
});
