/**
 * Browser runtime shims for server package
 *
 * This file is selected via package.json export conditions when bundling for
 * browsers. It binds the same platform choices as the workerd shim (the
 * cfWorker validator, the process stub) WITHOUT the module-scope
 * `preloadSchemas()` call: in a browser, module evaluation is page load —
 * boot latency — so schema construction stays lazy, exactly like Node.
 */
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core-internal/validators/cfWorker';

/**
 * Stub process object for non-Node.js environments.
 * StdioServerTransport is not supported in Cloudflare Workers/browser environments.
 */
function notSupported(): never {
    throw new Error('StdioServerTransport is not supported in this environment. Use StreamableHTTPServerTransport instead.');
}

export const process = {
    get stdin(): never {
        return notSupported();
    },
    get stdout(): never {
        return notSupported();
    }
};
