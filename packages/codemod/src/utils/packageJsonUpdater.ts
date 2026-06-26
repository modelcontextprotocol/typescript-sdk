import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { V2_PACKAGE_VERSIONS } from '../generated/versions';
import type { PackageJsonChange } from '../types';
import { findPackageJson } from './projectAnalyzer';

const V1_PACKAGE = '@modelcontextprotocol/sdk';
const PRIVATE_PACKAGES = new Set(['@modelcontextprotocol/core-internal']);

function normalizeToRoot(pkg: string): string {
    const secondSlash = pkg.indexOf('/', pkg.indexOf('/') + 1);
    if (secondSlash === -1) return pkg;
    return pkg.slice(0, secondSlash);
}

function detectIndent(text: string): string {
    const match = text.match(/\n([ \t]+)/);
    return match ? match[1]! : '  ';
}

/**
 * For each discovered `package.json`, attribute the v2 packages used by the source files it owns
 * (the manifest closest to a file walking up wins). The walk-up also covers a target directory that
 * sits inside a package whose manifest lives above it.
 *
 * Returned map keys are absolute manifest paths; values are the v2 package specifiers (possibly
 * subpaths — `applyPackageJsonUpdate` normalizes to the root package name).
 */
export function attributeUsedPackages(
    targetDir: string,
    packageJsonPaths: string[],
    perFileUsed: Map<string, Set<string>>
): Map<string, Set<string>> {
    // Owners sorted longest-first so the deepest enclosing manifest wins.
    const ownerDirs = packageJsonPaths.map(p => path.dirname(p)).toSorted((a, b) => b.length - a.length);
    const result = new Map<string, Set<string>>();

    // A run pointed at a sub-directory may not contain its own package.json — fall back to walk-up.
    const fallback = findPackageJson(targetDir);

    const ownerOf = (filePath: string): string | undefined => {
        const dir = path.dirname(filePath);
        for (const ownerDir of ownerDirs) {
            if (dir === ownerDir || dir.startsWith(ownerDir + path.sep)) return path.join(ownerDir, 'package.json');
        }
        return fallback;
    };

    for (const [filePath, used] of perFileUsed) {
        if (used.size === 0) continue;
        const owner = ownerOf(filePath);
        if (!owner) continue;
        let bucket = result.get(owner);
        if (!bucket) result.set(owner, (bucket = new Set()));
        for (const p of used) bucket.add(p);
    }

    // Manifests that own no changed files (or whose files only used packages later pruned by the
    // surviving-specifier check) still get an entry so the v1 SDK is removed and zod is checked.
    for (const p of packageJsonPaths) {
        if (!result.has(p)) result.set(p, new Set());
    }
    if (fallback && !result.has(fallback)) result.set(fallback, new Set());

    return result;
}

/**
 * Apply the v1→v2 dependency swap to a single manifest. Returns `undefined` when the manifest does
 * not depend on the v1 SDK (so a monorepo's tooling-only packages and the workspace root are left
 * alone) or cannot be read/parsed.
 *
 * A `zod@^3` range is reported (not rewritten): v2 imports from `zod/v4`, but bumping a user's
 * Zod major can break their own non-SDK Zod code, so the choice (bump to ^4, or pin ^3.25+ and
 * import from `zod/v4`) is theirs. The note text matches the §Packaging guidance in
 * `docs/migration/upgrade-to-v2.md`.
 */
export function applyPackageJsonUpdate(pkgJsonPath: string, usedPackages: Set<string>, dryRun: boolean): PackageJsonChange | undefined {
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

    const notes: string[] = [];
    const zodRange = deps?.['zod'] ?? devDeps?.['zod'];
    if (zodRange && /^[~^]?3\./.test(zodRange)) {
        notes.push(
            `\`zod\` is at ${zodRange}. SDK v2 imports from 'zod/v4'. Either bump to zod@^4 ` +
                `(review zod's own migration guide for your code) or pin ^3.25+ and import from 'zod/v4'. ` +
                `See docs/migration/upgrade-to-v2.md §Packaging.`
        );
    }

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
        packageJsonPath: pkgJsonPath,
        ...(notes.length > 0 ? { notes } : {})
    };
}

/** Back-compat single-manifest entry point used by the existing unit tests. */
export function updatePackageJson(targetDir: string, usedPackages: Set<string>, dryRun: boolean): PackageJsonChange | undefined {
    const pkgJsonPath = findPackageJson(targetDir);
    if (!pkgJsonPath) return undefined;
    return applyPackageJsonUpdate(pkgJsonPath, usedPackages, dryRun);
}
