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

/**
 * Single-slot fallback — browsers have no `node:async_hooks`. See the
 * identical implementation in `shimsWorkerd.ts` for the scope/limitations of
 * this fallback (synchronous-scope only, unlike the real `AsyncLocalStorage`).
 */
export class AsyncLocalStorage<T> {
    private _store: T | undefined;
    getStore(): T | undefined {
        return this._store;
    }
    run<A extends unknown[], R>(store: T, cb: (...args: A) => R, ...args: A): R {
        const prev = this._store;
        this._store = store;
        try {
            return cb(...args);
        } finally {
            this._store = prev;
        }
    }
}
