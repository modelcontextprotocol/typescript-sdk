/**
 * The rules server and client extensions share: unique ids, dependencies on
 * other extensions, and checked request handler registration. `McpServer` and
 * `Client` set extensions up with these, so both sides refuse the same things
 * with the same messages.
 */
import type { StandardSchemaV1 } from '../util/standardSchema';
import { isExtensionReusedRequestMethod, isSpecRequestMethod } from '../wire/codec';
import type { BaseContext, InferHandlerResult, Protocol } from './protocol';

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
