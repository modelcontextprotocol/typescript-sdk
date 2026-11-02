/**
 * Node.js runtime shims for server package
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
export { default as process } from 'node:process';
