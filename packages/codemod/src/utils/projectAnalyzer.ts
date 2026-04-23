import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { TransformContext } from '../types.js';

export function analyzeProject(targetDir: string): TransformContext {
    const pkgJsonPath = path.join(targetDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
        return { projectType: 'unknown' };
    }

    try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        const allDeps = {
            ...pkgJson.dependencies,
            ...pkgJson.devDependencies
        };

        const hasClient = '@modelcontextprotocol/client' in allDeps;
        const hasServer = '@modelcontextprotocol/server' in allDeps;

        if (hasClient && hasServer) return { projectType: 'both' };
        if (hasClient) return { projectType: 'client' };
        if (hasServer) return { projectType: 'server' };
        return { projectType: 'unknown' };
    } catch {
        return { projectType: 'unknown' };
    }
}

export function resolveTypesPackage(context: TransformContext, fileHasClientImports: boolean, fileHasServerImports: boolean): string {
    if (fileHasClientImports && !fileHasServerImports) {
        return '@modelcontextprotocol/client';
    }
    if (fileHasServerImports && !fileHasClientImports) {
        return '@modelcontextprotocol/server';
    }
    if (context.projectType === 'client') {
        return '@modelcontextprotocol/client';
    }
    if (context.projectType === 'server') {
        return '@modelcontextprotocol/server';
    }
    return '@modelcontextprotocol/server';
}
