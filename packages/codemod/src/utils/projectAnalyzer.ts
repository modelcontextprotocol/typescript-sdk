import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { TransformContext } from '../types.js';

const PROJECT_ROOT_MARKERS = ['.git', 'node_modules'];

function findPackageJson(startDir: string): string | undefined {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;
    while (true) {
        const candidate = path.join(dir, 'package.json');
        if (existsSync(candidate)) return candidate;
        if (dir === root) return undefined;
        if (PROJECT_ROOT_MARKERS.some(m => existsSync(path.join(dir, m)))) return undefined;
        dir = path.dirname(dir);
    }
}

export function analyzeProject(targetDir: string): TransformContext {
    const pkgJsonPath = findPackageJson(targetDir);
    if (!pkgJsonPath) {
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
