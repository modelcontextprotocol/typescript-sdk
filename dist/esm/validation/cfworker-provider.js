/**
 * Cloudflare Worker-compatible JSON Schema validator provider
 *
 * This provider uses @cfworker/json-schema for validation without code generation,
 * making it compatible with edge runtimes like Cloudflare Workers that restrict
 * eval and new Function.
 */
import { Validator } from '@cfworker/json-schema';
/**
 *
 * @example
 * ```typescript
 * // Use with default configuration (2020-12, shortcircuit)
 * const validator = new CfWorkerJsonSchemaValidator();
 *
 * // Use with custom configuration
 * const validator = new CfWorkerJsonSchemaValidator({
 *   draft: '2020-12',
 *   shortcircuit: false // Report all errors
 * });
 * ```
 */
export class CfWorkerJsonSchemaValidator {
    /**
     * Create a validator
     *
     * @param options - Configuration options
     * @param options.shortcircuit - If true, stop validation after first error (default: true)
     * @param options.draft - JSON Schema draft version to use (default: '2020-12')
     */
    constructor(options) {
        var _a, _b;
        this.shortcircuit = (_a = options === null || options === void 0 ? void 0 : options.shortcircuit) !== null && _a !== void 0 ? _a : true;
        this.draft = (_b = options === null || options === void 0 ? void 0 : options.draft) !== null && _b !== void 0 ? _b : '2020-12';
    }
    /**
     * Create a validator for the given JSON Schema
     *
     * Unlike AJV, this validator is not cached internally
     *
     * @param schema - Standard JSON Schema object
     * @returns A validator function that validates input data
     */
    getValidator(schema) {
        const cfSchema = schema;
        const validator = new Validator(cfSchema, this.draft, this.shortcircuit);
        return (input) => {
            const result = validator.validate(input);
            if (result.valid) {
                return {
                    valid: true,
                    data: input,
                    errorMessage: undefined
                };
            }
            else {
                return {
                    valid: false,
                    data: undefined,
                    errorMessage: result.errors.map(err => `${err.instanceLocation}: ${err.error}`).join('; ')
                };
            }
        };
    }
}
//# sourceMappingURL=cfworker-provider.js.map