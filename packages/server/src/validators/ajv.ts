/**
 * Customisation entry point for the AJV validator. Re-exports `Ajv2020` + `addFormats` from
 * the SDK's bundled copy, so customising the validator needs no extra installs.
 *
 * @example
 * ```ts
 * import { Ajv2020, addFormats, AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
 *
 * const ajv = new Ajv2020({ strict: true, allErrors: true });
 * addFormats(ajv);
 * const validator = new AjvJsonSchemaValidator(ajv);
 * ```
 */
export { addFormats, Ajv, Ajv2020, AjvJsonSchemaValidator } from '@modelcontextprotocol/core-internal/validators/ajv';
