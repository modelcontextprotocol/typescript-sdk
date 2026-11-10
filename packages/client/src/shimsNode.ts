/**
 * Node.js runtime shims for client package
 *
 * This file is selected via package.json export conditions when running in Node.js.
 */
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/core-internal/validators/ajv';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/core-internal/validators/cfWorker';

/**
 * Ajv compiles validators with `new Function`. A Node process can disallow that
 * (`--disallow-code-generation-from-strings`, or a host that sets it), and Ajv
 * then throws an `EvalError` on the first schema. Such a process gets the
 * validator the workerd and browser shims use, which does not generate code.
 */
function canGenerateCode(): boolean {
    try {
        new Function('');
        return true;
    } catch {
        return false;
    }
}

export const DefaultJsonSchemaValidator: typeof AjvJsonSchemaValidator | typeof CfWorkerJsonSchemaValidator = canGenerateCode()
    ? AjvJsonSchemaValidator
    : CfWorkerJsonSchemaValidator;

/**
 * Whether `fetch()` may throw `TypeError` due to CORS. CORS is a browser-only concept —
 * in Node.js, a `TypeError` from `fetch` is always a real network/configuration error
 * (DNS resolution, connection refused, invalid URL), never a CORS error.
 */
export const CORS_IS_POSSIBLE = false;
