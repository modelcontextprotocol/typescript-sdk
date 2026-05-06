import { readFileSync, writeFileSync } from 'node:fs';

import { V2_PACKAGE_VERSIONS } from '../generated/versions.js';
import type { PackageJsonChange } from '../types.js';
import { findPackageJson } from './projectAnalyzer.js';

const V1_PACKAGE = '@modelcontextprotocol/sdk';
const PRIVATE_PACKAGES = new Set(['@modelcontextprotocol/core']);

function normalizeToRoot(pkg: string): string {
    const secondSlash = pkg.indexOf('/', pkg.indexOf('/') + 1);
    if (secondSlash === -1) return pkg;
    return pkg.slice(0, secondSlash);
}

function detectIndent(text: string): string {
    const match = text.match(/\n([ \t]+)/);
    return match ? match[1]! : '  ';
}

export function updatePackageJson(targetDir: string, usedPackages: Set<string>, dryRun: boolean): PackageJsonChange | undefined {
    const pkgJsonPath = findPackageJson(targetDir);
    if (!pkgJsonPath) return undefined;

    let raw: string;
    let pkgJson: Record<string, unknown>;
    try {
        raw = readFileSync(pkgJsonPath, 'utf8');
        pkgJson = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return undefined;
    }
    const deps = pkgJson.dependencies as Record<string, string> | undefined;
    const devDeps = pkgJson.devDependencies as Record<string, string> | undefined;

    const inDeps = deps !== undefined && V1_PACKAGE in deps;
    const inDevDeps = devDeps !== undefined && V1_PACKAGE in devDeps;
    if (!inDeps && !inDevDeps) return undefined;

    const packagesToAdd = [...new Set([...usedPackages].map(pkg => normalizeToRoot(pkg)))].filter(
        pkg => !PRIVATE_PACKAGES.has(pkg) && pkg in V2_PACKAGE_VERSIONS
    );

    // Determine which section to add v2 packages to.
    // If v1 SDK was in both, prefer dependencies.
    const targetSection = inDeps ? 'dependencies' : 'devDependencies';

    const added: string[] = [];
    for (const pkg of packagesToAdd) {
        const alreadyInDeps = deps !== undefined && pkg in deps;
        const alreadyInDevDeps = devDeps !== undefined && pkg in devDeps;
        if (alreadyInDeps || alreadyInDevDeps) continue;

        if (!pkgJson[targetSection]) {
            pkgJson[targetSection] = {};
        }
        (pkgJson[targetSection] as Record<string, string>)[pkg] = V2_PACKAGE_VERSIONS[pkg]!;
        added.push(pkg);
    }

    if (inDeps) delete deps![V1_PACKAGE];
    if (inDevDeps) delete devDeps![V1_PACKAGE];
    const removed = [V1_PACKAGE];

    if (!dryRun) {
        const indent = detectIndent(raw);
        const trailingNewline = raw.endsWith('\n');
        let output = JSON.stringify(pkgJson, null, indent);
        if (trailingNewline) output += '\n';
        writeFileSync(pkgJsonPath, output);
    }

    return {
        added: added.toSorted(),
        removed,
        packageJsonPath: pkgJsonPath
    };
}
