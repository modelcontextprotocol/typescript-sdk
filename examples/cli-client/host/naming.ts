/**
 * Per-server tool names are namespaced `mcp__<server>__<tool>` before they reach the model
 * (the same scheme Claude Code uses), so two servers can both expose `search` and the host
 * can always route a model-issued call back to the server that owns it.
 */
export function sanitizeServerName(name: string): string {
    return name.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
}

export function namespaceTool(serverKey: string, toolName: string): string {
    return `mcp__${serverKey}__${toolName}`;
}

export function routeNamespacedTool(name: string, serverKeys: string[]): { serverKey: string; toolName: string } | undefined {
    for (const serverKey of serverKeys.toSorted((a, b) => b.length - a.length)) {
        const prefix = `mcp__${serverKey}__`;
        if (name.startsWith(prefix) && name.length > prefix.length) {
            return { serverKey, toolName: name.slice(prefix.length) };
        }
    }
    return undefined;
}
