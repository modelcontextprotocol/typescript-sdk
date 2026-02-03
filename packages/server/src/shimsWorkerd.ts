/**
 * Cloudflare Workers runtime shims for server package
 *
 * This file is selected via package.json export conditions when running in workerd.
 */
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core';

/**
 * Web Crypto API compatible randomBytes implementation for Cloudflare Workers.
 * Matches the signature of node:crypto's randomBytes(size) returning a Buffer-like object.
 */
export function randomBytes(size: number): { toString(encoding: 'hex'): string } {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    return {
        toString(encoding: 'hex'): string {
            if (encoding !== 'hex') {
                throw new Error(`Unsupported encoding: ${encoding}`);
            }
            return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        }
    };
}

/**
 * Stub process object for non-Node.js environments.
 * StdioServerTransport is not supported in Cloudflare Workers/browser environments.
 */
function notSupported(): never {
    throw new Error('StdioServerTransport is not supported in this environment. Use StreamableHTTPServerTransport instead.');
}

export const process = {
    get stdin(): never { return notSupported(); },
    get stdout(): never { return notSupported(); },
};
