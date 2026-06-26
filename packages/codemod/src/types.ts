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
    /**
     * User override (`--prefer client|server`) applied when the project-type heuristic returns
     * `unknown` for a file, instead of the hard-coded `server` default. Threaded into the context so
     * the per-file `resolveTypesPackage` fallback can honour it.
     */
    prefer?: 'client' | 'server';
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
    /** Default package for context-resolved imports when the project-type heuristic finds nothing. */
    prefer?: 'client' | 'server';
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
    /** Advisory messages about this manifest (e.g. zod v3 detected, missing zod dependency). */
    notes?: string[];
}

export interface RunnerResult {
    filesChanged: number;
    totalChanges: number;
    diagnostics: Diagnostic[];
    fileResults: FileResult[];
    /**
     * One entry per `package.json` updated. A monorepo run updates every workspace member that
     * depends on the v1 SDK; a single-package run yields at most one entry.
     */
    packageJsonChanges?: PackageJsonChange[];
    commentCount: number;
}
