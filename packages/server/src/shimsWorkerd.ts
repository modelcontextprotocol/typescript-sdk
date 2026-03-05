/**
 * Cloudflare Workers runtime shims for server package
 *
 * This file is selected via package.json export conditions when running in workerd.
 */
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core';

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
