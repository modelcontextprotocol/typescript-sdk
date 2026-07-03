/** Wrangler bundles .html imports as text modules (see the [[rules]] block in wrangler.toml). */
declare module '*.html' {
    const text: string;
    export default text;
}

/**
 * Minimal structural declaration for the Workers runtime module, matching what
 * this example uses (the provider dispatches API requests to a WorkerEntrypoint
 * subclass). Swap for @cloudflare/workers-types if the surface grows.
 */
declare module 'cloudflare:workers' {
    export class WorkerEntrypoint<Env = unknown> {
        protected readonly env: Env;
        protected readonly ctx: { props?: unknown };
        fetch?(request: Request): Response | Promise<Response>;
    }
}

/** The board page's client script, bundled as text and inlined at render time. */
declare module '*.client.js' {
    const text: string;
    export default text;
}
