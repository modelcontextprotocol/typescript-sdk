import type { EventDescriptor, ListEventsResult } from '@modelcontextprotocol/core/ext/events';
import { EVENTS_LIST_METHOD, ListEventsResultSchema } from '@modelcontextprotocol/core/ext/events';
import type { RequestOptions, StandardSchemaV1, XMcpHeaderDeclaration } from '@modelcontextprotocol/core-internal';
import { buildMcpParamHeaders, ProtocolError, scanXMcpHeaderDeclarations } from '@modelcontextprotocol/core-internal';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import type { Client } from '../../client/client';
import { clientInternals } from '../../client/client';
import { detectProbeEnvironment, detectProbeTransportKind } from '../../client/versionNegotiation';
import { isHeaderMismatch } from './recovery';

// The event type a request is about, whose annotated arguments become `Mcp-Param` headers.
export interface ParamMirror {
    name: string;
    arguments?: Record<string, unknown>;
}

// An events-coded `ProtocolError` as the `EventsError` it stands for; anything else unchanged.
export function asEventsError(error: unknown): unknown {
    if (!(error instanceof ProtocolError) || error instanceof EventsError) return error;
    return EventsError.fromProtocolError(error) ?? error;
}

// One client's `events/*` requests, and the descriptors (by name) of its last `events/list` that `Mcp-Param` headers are built from.
export class EventsConnection {
    readonly client: Client;
    readonly #descriptors = new Map<string, { descriptor: EventDescriptor; declarations: readonly XMcpHeaderDeclaration[] }>();
    readonly #closeListeners = new Set<() => void>();

    constructor(client: Client) {
        this.client = client;
        clientInternals.onClose(client, () => {
            // A snapshot, so a listener that adds or removes another does not change who runs this time.
            const listeners = [...this.#closeListeners];
            for (const listener of listeners) {
                try {
                    listener();
                } catch (error) {
                    this.report(error);
                }
            }
        });
    }

    // Runs `listener` when the client's connection closes or a fresh connect replaces it, until the returned function removes it.
    onClose(listener: () => void): () => void {
        this.#closeListeners.add(listener);
        return () => void this.#closeListeners.delete(listener);
    }

    // Hands an error nothing else can surface to the client's onerror.
    report(error: unknown): void {
        this.client.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }

    descriptor(name: string): EventDescriptor | undefined {
        return this.#descriptors.get(name)?.descriptor;
    }

    // Every page (no cursor) or that one page; drops event types with invalid `x-mcp-header` annotations and caches the rest.
    async list(cursor?: string, options?: RequestOptions): Promise<ListEventsResult> {
        const fetchPage = (at: string | undefined): Promise<ListEventsResult> =>
            this.request(EVENTS_LIST_METHOD, at === undefined ? {} : { cursor: at }, ListEventsResultSchema, undefined, options);
        let result: ListEventsResult;
        if (cursor === undefined) {
            result = await clientInternals.walkPages(this.client, EVENTS_LIST_METHOD, fetchPage, page => page.events);
            delete result.nextCursor;
            this.#descriptors.clear();
        } else {
            result = await fetchPage(cursor);
        }
        result.events = result.events.filter(descriptor => this.#cache(descriptor));
        return result;
    }

    // `Mcp-Param-{Name}` headers for a request about `name`, from its cached descriptor; none while mirroring is off.
    paramHeadersFor(name: string, args: Record<string, unknown> | undefined): Record<string, string> {
        const declarations = this.mirroring() ? this.#descriptors.get(name)?.declarations : undefined;
        return declarations === undefined || declarations.length === 0 ? {} : buildMcpParamHeaders(declarations, args);
    }

    // Whether requests carry `Mcp-Param` headers: on 2026-07-28 outside a browser, as for `tools/call`.
    mirroring(): boolean {
        return this.client.getProtocolEra() === 'modern' && detectProbeEnvironment() !== 'browser';
    }

    // With `mirror`, carries its `Mcp-Param` headers and, while mirroring, after a `-32020` re-lists once and retries. Events-coded errors become `EventsError`.
    async request<S extends StandardSchemaV1>(
        method: string,
        params: Record<string, unknown>,
        schema: S,
        mirror: ParamMirror | undefined,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<S>> {
        const send = (): Promise<StandardSchemaV1.InferOutput<S>> => {
            const headers = mirror === undefined ? {} : this.paramHeadersFor(mirror.name, mirror.arguments);
            const sendOptions = Object.keys(headers).length === 0 ? options : { ...options, headers: { ...options?.headers, ...headers } };
            return this.client.request({ method, params }, schema, sendOptions);
        };
        try {
            try {
                return await send();
            } catch (error) {
                if (mirror === undefined || !isHeaderMismatch(error) || !this.mirroring()) throw error;
                await this.list(undefined, options);
                return await send();
            }
        } catch (error) {
            throw asEventsError(error);
        }
    }

    // As `tools/list` does: exclusion applies except on stdio, which carries no headers.
    #cache(descriptor: EventDescriptor): boolean {
        const scan = scanXMcpHeaderDeclarations(descriptor.inputSchema);
        const transport = this.client.transport;
        if (!scan.valid && transport !== undefined && detectProbeTransportKind(transport) !== 'stdio') {
            this.#descriptors.delete(descriptor.name);
            // eslint-disable-next-line no-console -- the warning the SEP asks for, as tools/list gives it
            console.warn(
                `[mcp-sdk] excluding event type '${descriptor.name}' from events/list: invalid x-mcp-header declaration — ${scan.reason}`
            );
            return false;
        }
        this.#descriptors.set(descriptor.name, { descriptor, declarations: scan.valid ? scan.declarations : [] });
        return true;
    }
}
