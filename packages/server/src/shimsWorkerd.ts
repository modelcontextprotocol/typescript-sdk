/**
 * Cloudflare Workers runtime shims for server package
 *
 * This file is selected via package.json export conditions when running in workerd.
 */
import { preloadSchemas } from '@modelcontextprotocol/core-internal';

export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/core-internal/validators/cfWorker';

// Platform asymmetry: isolate platforms like workerd evaluate module scope
// during deployment/isolate warm-up, outside any request's billed CPU, while
// lazy construction would land inside the first request each fresh isolate
// serves. The Node and browser shims stay lazy — there, module evaluation is
// process/page startup and boot latency is the cost that matters.
preloadSchemas();

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
 * Single-slot fallback for environments without `node:async_hooks` (workerd
 * without the `nodejs_compat` flag). Unlike the real `AsyncLocalStorage`, the
 * store is only guaranteed live for the SYNCHRONOUS portion of `run()`'s
 * callback — it is cleared as soon as that call returns, not after any
 * promise it returns settles. This still covers the common case (a handler
 * that triggers a related notification before its first `await`); a handler
 * that awaits first and only then triggers one loses the association here.
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
