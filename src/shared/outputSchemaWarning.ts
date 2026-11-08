/**
 * Registration-time warning for non-object output schemas.
 *
 * The MCP specification requires `Tool.outputSchema` to be an object schema
 * (type: "object" at its root), so a non-object root (union, optional, …) cannot be
 * serialized into `tools/list` — clients would never see it and would not validate
 * the tool's output. `tools/call` still validates against the schema itself. This
 * warning makes the listing omission visible instead of silent (#1308).
 */

export function issueNonObjectOutputSchemaWarning(name: string): void {
    console.warn(`Tool outputSchema warning for "${name}":`);
    console.warn(
        '  - The outputSchema is not an object schema, so tools/list cannot advertise it (the MCP specification requires type "object" at the root).'
    );
    console.warn("  - tools/call still validates results against it, but clients will not validate this tool's output.");
    console.warn('Consider wrapping the schema in z.object(...) — e.g. merging an error envelope in as an optional `error` property.');
}
