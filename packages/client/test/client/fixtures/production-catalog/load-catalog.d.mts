export interface CatalogTool {
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown> & { $id?: string };
    annotations?: unknown;
}

export interface ProductionCatalogIdentity {
    label: string;
    rea: { repository: string; commit: string; license: string; licenseFile: string };
    toolsFile: { rawSha256: string; documentSha256: string; gzipSha256: string };
    structuredContentSha256: string;
    invokedTool: string;
}

export interface ProductionCatalog {
    identity: ProductionCatalogIdentity;
    tools: CatalogTool[];
    structuredContent: { result: { open: boolean } };
    input: Record<string, unknown>;
}

export function loadProductionCatalog(): ProductionCatalog;
