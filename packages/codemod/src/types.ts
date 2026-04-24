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
}

export interface RunnerResult {
    filesChanged: number;
    totalChanges: number;
    diagnostics: Diagnostic[];
    fileResults: FileResult[];
    packageJsonChanges?: PackageJsonChange;
}
