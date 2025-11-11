import { getSupportedElicitationModes } from './elicitation-utils.js';

describe('elicitation-utils', () => {
    describe('getSupportedElicitationModes', () => {
        it('should support nothing when capabilities are undefined', () => {
            const result = getSupportedElicitationModes(undefined);
            expect(result.supportsFormMode).toBe(false);
            expect(result.supportsUrlMode).toBe(false);
        });

        it('should default to form mode when capabilities are an empty object', () => {
            const result = getSupportedElicitationModes({});
            expect(result.supportsFormMode).toBe(true);
            expect(result.supportsUrlMode).toBe(false);
        });

        it('should support form mode when form is explicitly declared', () => {
            const result = getSupportedElicitationModes({ form: {} });
            expect(result.supportsFormMode).toBe(true);
            expect(result.supportsUrlMode).toBe(false);
        });

        it('should support url mode when url is explicitly declared', () => {
            const result = getSupportedElicitationModes({ url: {} });
            expect(result.supportsFormMode).toBe(false);
            expect(result.supportsUrlMode).toBe(true);
        });

        it('should support both modes when both are explicitly declared', () => {
            const result = getSupportedElicitationModes({ form: {}, url: {} });
            expect(result.supportsFormMode).toBe(true);
            expect(result.supportsUrlMode).toBe(true);
        });

        it('should support form mode when only applyDefaults is present', () => {
            const result = getSupportedElicitationModes({ applyDefaults: true });
            expect(result.supportsFormMode).toBe(true);
            expect(result.supportsUrlMode).toBe(false);
        });

        it('should support form mode when applyDefaults and form are present', () => {
            const result = getSupportedElicitationModes({ applyDefaults: true, form: {} });
            expect(result.supportsFormMode).toBe(true);
            expect(result.supportsUrlMode).toBe(false);
        });

        it('should support url mode when applyDefaults and url are present', () => {
            const result = getSupportedElicitationModes({ applyDefaults: true, url: {} });
            expect(result.supportsFormMode).toBe(false);
            expect(result.supportsUrlMode).toBe(true);
        });

        it('should support both modes when applyDefaults, form, and url are present', () => {
            const result = getSupportedElicitationModes({ applyDefaults: true, form: {}, url: {} });
            expect(result.supportsFormMode).toBe(true);
            expect(result.supportsUrlMode).toBe(true);
        });
    });
});
