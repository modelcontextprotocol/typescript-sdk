/**
 * The rules server and client extensions share: unique ids, dependencies on
 * other extensions, and checked request handler registration. `McpServer` and
 * `Client` set extensions up with these, so both sides refuse the same things
 * with the same messages.
 */
import type { JSONObject } from '../types/spec.types.2026-07-28';
import type { StandardSchemaV1 } from '../util/standardSchema';
import { isExtensionReusedRequestMethod, isSpecRequestMethod } from '../wire/codec';
import type { BaseContext, InferHandlerResult, Protocol, RequestMiddleware } from './protocol';

/** What installed extensions add to one server or client, kept off its public surface. */
interface ExtensionState {
    /** Ids of the installed extensions; their capability entries belong to them. */
    readonly owned: ReadonlySet<string>;
    /** Middleware from `ctx.use`, in setup order; it runs outside middleware added with `use()`. */
    readonly middleware: Array<{ method: string; middleware: RequestMiddleware<BaseContext> }>;
    /** Pending while a `setup` is unfinished, and kept when one fails; `connect` waits for it. */
    ready?: Promise<void>;
    /** The extension whose capability entry is being written. */
    writing?: string;
}

const states = new WeakMap<object, ExtensionState>();

/** The extension state of `protocol`, when it installed any extensions. */
export function extensionStateOf(protocol: object): Readonly<ExtensionState> | undefined {
    return states.get(protocol);
}

/**
 * Throws when `capabilities` sets an entry under `extensions` that belongs to
 * an installed extension, unless that extension is writing it. Called by
 * `registerCapabilities`, so the entry has one owner.
 */
export function assertExtensionCapabilitiesUnowned(protocol: object, capabilities: { extensions?: object }): void {
    const state = states.get(protocol);
    if (state === undefined || capabilities.extensions === undefined) return;
    for (const id of Object.keys(capabilities.extensions)) {
        if (state.owned.has(id) && state.writing !== id) {
            throw new Error(
                `capabilities.extensions["${id}"] belongs to the installed "${id}" extension; set it from the extension with ctx.capability`
            );
        }
    }
}

/** Writes `settings` as the capability entry of extension `id`. */
export function writeExtensionCapability(
    protocol: object,
    id: string,
    settings: JSONObject,
    register: (capabilities: { extensions: Record<string, JSONObject> }) => void
): void {
    const state = states.get(protocol);
    if (state !== undefined) state.writing = id;
    try {
        register({ extensions: { [id]: settings } });
    } finally {
        if (state !== undefined) state.writing = undefined;
    }
}

/** `ctx.use`: middleware in the extension tier, outside middleware the application adds with `use()`. */
export function useAsExtension<ContextT extends BaseContext>(
    protocol: Protocol<ContextT>,
    method: string,
    middleware: RequestMiddleware<ContextT>
): void {
    if (typeof middleware !== 'function') throw new TypeError('use: middleware is required');
    const state = states.get(protocol);
    if (state === undefined) throw new Error('use: this server or client installed no extensions');
    // The protocol composes it with its own context type (see `Protocol._middlewareFor`).
    state.middleware.push({ method, middleware: middleware as unknown as RequestMiddleware<BaseContext> });
}

/**
 * Installs `extensions` on `protocol`, in order. Before any `setup` runs it
 * checks that ids are unique, that each extension has a `setup`, and that no
 * entry under `capabilities.extensions` already exists for an installed id.
 * Each extension is advertised as `{}`, then its `setup` runs. A `setup` that
 * throws fails the caller (the constructor). A `setup` that returns a promise
 * defers the ones after it until it settles, and `connect` waits for all of
 * them, rejecting if one fails, so no message is processed with an extension
 * partly set up.
 */
export function installExtensions<E extends { readonly id: string; setup(ctx: C): void | PromiseLike<void> }, C>(
    protocol: object,
    extensions: readonly E[],
    existing: { extensions?: object } | undefined,
    register: (capabilities: { extensions: Record<string, JSONObject> }) => void,
    contextFor: (id: string, installed: ReadonlySet<string>) => C
): void {
    const ids = uniqueExtensionIds(extensions);
    for (const extension of extensions) {
        if (typeof extension.setup !== 'function') {
            throw new TypeError(`Extension "${String((extension as { id: unknown }).id)}" has no setup`);
        }
    }
    for (const id of ids) {
        if (existing?.extensions !== undefined && id in existing.extensions) {
            throw new Error(
                `Extension "${id}" is also set in capabilities.extensions; drop that entry and set its settings from the extension with ctx.capability`
            );
        }
    }
    if (ids.size === 0) return;

    const state: ExtensionState = { owned: ids, middleware: [] };
    states.set(protocol, state);
    const setUp = (extension: E): void | PromiseLike<void> => {
        writeExtensionCapability(protocol, extension.id, {}, register);
        return extension.setup(contextFor(extension.id, ids));
    };
    let pending: Promise<void> | undefined;
    for (const extension of extensions) {
        if (pending !== undefined) {
            pending = pending.then(() => setUp(extension));
            continue;
        }
        const result = setUp(extension);
        if (isThenable(result)) pending = Promise.resolve(result);
    }
    if (pending !== undefined) {
        state.ready = pending;
        // `connect` reports a failure; nothing else may treat it as unhandled.
        pending.then(
            () => {
                state.ready = undefined;
            },
            () => {}
        );
    }
}

function isThenable(value: unknown): value is PromiseLike<void> {
    return (
        (typeof value === 'object' || typeof value === 'function') &&
        value !== null &&
        typeof (value as { then?: unknown }).then === 'function'
    );
}

/**
 * Returns the extensions' ids, or throws when two share one. Runs before any
 * extension is set up, so a duplicate leaves the server or client untouched,
 * and every `setup` can see the full list.
 */
export function uniqueExtensionIds(extensions: readonly { readonly id: string }[]): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const { id } of extensions) {
        if (ids.has(id)) throw new Error(`Extension "${id}" is listed more than once; pass each extension once`);
        ids.add(id);
    }
    return ids;
}

/**
 * Throws, naming both extensions, when `extension` requires an extension
 * that is not in `installed`. `installed` is the full list, known before any
 * `setup` runs, so the order extensions are listed in doesn't matter.
 */
export function requireExtension(side: 'server' | 'client', installed: ReadonlySet<string>, extension: string, required: string): void {
    if (!installed.has(required)) {
        throw new Error(`Extension "${extension}" requires the "${required}" extension, which this ${side} does not install`);
    }
}

/**
 * `setRequestHandler` on the extension path. It refuses a core method name
 * of any protocol version, which an extension wraps with `use` instead (except
 * the names SEP-2663 reuses for the Tasks extension), and a method that
 * already has a handler, such as another extension's.
 */
export function setExtensionRequestHandler<
    ContextT extends BaseContext,
    P extends StandardSchemaV1,
    R extends StandardSchemaV1 | undefined = undefined
>(
    protocol: Protocol<ContextT>,
    extension: string,
    name: string,
    schemas: { params: P; result?: R },
    handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ContextT) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
): void {
    if (isSpecRequestMethod(name) && !isExtensionReusedRequestMethod(name)) {
        throw new Error(`Extension "${extension}" cannot register "${name}": it is a core method; wrap it with use() instead`);
    }
    try {
        protocol.assertCanSetRequestHandler(name);
    } catch {
        throw new Error(`Extension "${extension}" cannot register "${name}": another handler already serves it`);
    }
    protocol.setRequestHandler(name, schemas, handler);
}
