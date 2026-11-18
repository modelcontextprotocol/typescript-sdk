import type { McpServer } from './mcp';

export type ParamHeaderSchemaLookup = (name: string) => Record<string, unknown> | undefined;

// Per server, the methods besides `tools/call` whose `Mcp-Param-*` headers `createMcpHandler` validates, each with its schema lookup by `params.name`.
const sources = new WeakMap<McpServer, Map<string, ParamHeaderSchemaLookup>>();

// Makes `createMcpHandler` validate `Mcp-Param-*` headers on `methods` against the JSON inputSchema `resolve` returns for `params.name`.
export function registerParamHeaderSource(mcp: McpServer, methods: readonly string[], resolve: ParamHeaderSchemaLookup): void {
    const lookups = sources.get(mcp) ?? new Map<string, ParamHeaderSchemaLookup>();
    for (const method of methods) lookups.set(method, resolve);
    sources.set(mcp, lookups);
}

// The JSON inputSchema whose `x-mcp-header` declarations a `method` request naming `name` is checked against, if one was registered.
export function paramHeaderSchemaFor(mcp: McpServer, method: string, name: string): Record<string, unknown> | undefined {
    return sources.get(mcp)?.get(method)?.(name);
}
