/**
 * Customisation entry point for the AJV validator. Re-exports `Ajv` + `addFormats` from the
 * SDK's bundled copy, so customising the validator needs no extra installs.
 *
 * @example
 * ```ts
 * import { Ajv, addFormats, AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
 *
 * const ajv = new Ajv({ strict: true, allErrors: true });
 * addFormats(ajv);
 * const validator = new AjvJsonSchemaValidator(ajv);
 * ```
 */
export { addFormats, Ajv, AjvJsonSchemaValidator } from '@modelcontextprotocol/core-internal/validators/ajv';
