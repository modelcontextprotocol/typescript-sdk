import type { SourceFile } from 'ts-morph';

export enum DiagnosticLevel {
    Error = 'error',
    Warning = 'warning',
    Info = 'info'
}

export interface Diagnostic {
    level: DiagnosticLevel;
    file: string;
    line: number;
    message: string;
    category?: 'v2-gap';
    /** Heuristic "verify this" advisories: dropped by the runner for files no transform changed, so re-runs over migrated trees stay quiet. */
    advisoryOnly?: boolean;
    /** Machine-readable marker for cross-stage plumbing (e.g. the runner feeding manifest edits). */
    tag?: 'zod-injected';
    insertComment?: boolean;
    resolveCurrentLine?: () => number;
}

export interface TransformResult {
    changesCount: number;
    diagnostics: Diagnostic[];
    usedPackages?: Set<string>;
}

export interface Transform {
    name: string;
    id: string;
    apply(sourceFile: SourceFile, context: TransformContext): TransformResult;
}

export interface TransformContext {
    projectType: 'client' | 'server' | 'both' | 'unknown';
}

export interface Migration {
    name: string;
    description: string;
    transforms: Transform[];
}

export interface RunnerOptions {
    targetDir: string;
    dryRun?: boolean;
    verbose?: boolean;
    transforms?: string[];
    ignore?: string[];
}

export interface FileResult {
    filePath: string;
    changes: number;
    diagnostics: Diagnostic[];
}

export interface PackageJsonChange {
    added: string[];
    removed: string[];
    packageJsonPath: string;
    /**
     * True for the manifest the codemod writes (the nearest one walking up from the
     * target directory) — or, under dry-run, the one it would write. False entries
     * describe edits to other manifests — typically workspace members — that are
     * reported for the user to apply themselves; those are never written.
     */
    applied: boolean;
    /** Context on how the change set was computed (e.g. hoisted member usage credited to this manifest). */
    notes?: string[];
    /** Manifest-level findings that need the user's attention (e.g. an incompatible zod range). */
    warnings?: string[];
}

export interface RunnerResult {
    filesChanged: number;
    totalChanges: number;
    diagnostics: Diagnostic[];
    fileResults: FileResult[];
    packageJsonChanges?: PackageJsonChange[];
    commentCount: number;
    /** Source files importing a v2 `@modelcontextprotocol/*` package after the run. */
    mcpImportFiles: number;
    /** Source files still importing the v1 `@modelcontextprotocol/sdk` package after the run (possible under `--transforms` subsets). */
    v1ImportFiles: number;
}
