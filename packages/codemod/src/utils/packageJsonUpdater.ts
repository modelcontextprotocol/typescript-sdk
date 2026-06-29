import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';

import { V2_PACKAGE_VERSIONS } from '../generated/versions';
import type { PackageJsonChange } from '../types';
import { findPackageJson } from './projectAnalyzer';

const V1_PACKAGE = '@modelcontextprotocol/sdk';
const PRIVATE_PACKAGES = new Set(['@modelcontextprotocol/core-internal']);

/** A zod range segment that can only resolve below 4.2 fails at runtime under v2 (surfaces on the first tools/list). */
const ZOD_TOO_OLD = /^(?:workspace:|npm:)?[\s=v~^><]*(3|4\.0|4\.1)(\.|\s|$)/;

/** Every `||` alternative must be too old before we warn — `^3.25 || ^4.5` resolves fine. */
function zodRangeTooOld(range: string): boolean {
    const segments = range.split('||').map(seg => seg.trim());
    return segments.length > 0 && segments.every(seg => ZOD_TOO_OLD.test(seg));
}

export interface ManifestInfo {
    /** Directory containing the manifest. */
    dir: string;
    /** Absolute path of the package.json. */
    path: string;
}

export function normalizeToRoot(pkg: string): string {
    const secondSlash = pkg.indexOf('/', pkg.indexOf('/') + 1);
    if (secondSlash === -1) return pkg;
    return pkg.slice(0, secondSlash);
}

/** ts-morph standardizes file paths to forward slashes on every platform; manifests must compare the same way. */
function toPosix(p: string): string {
    return p.replaceAll('\\', '/');
}

function detectIndent(text: string): string {
    const match = text.match(/\n([ \t]+)/);
    return match ? match[1]! : '  ';
}

function readJson(p: string): { raw: string; json: Record<string, unknown> } | undefined {
    try {
        const raw = readFileSync(p, 'utf8');
        return { raw, json: JSON.parse(raw) as Record<string, unknown> };
    } catch {
        return undefined;
    }
}

/** Parse the `packages:` list out of a pnpm-workspace.yaml without a YAML dependency. */
function pnpmWorkspaceGlobs(rootDir: string): string[] {
    const p = path.join(rootDir, 'pnpm-workspace.yaml');
    if (!existsSync(p)) return [];
    const globs: string[] = [];
    let inPackages = false;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (/^packages\s*:/.test(line)) {
            inPackages = true;
            continue;
        }
        if (inPackages) {
            const item = line.match(/^\s+-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
            if (item) {
                globs.push(item[1]!);
                continue;
            }
            if (/^\S/.test(line)) inPackages = false; // next top-level key
        }
    }
    return globs;
}

/** Workspace member globs from the root manifest's `workspaces` field (npm/yarn/bun shape). */
function npmWorkspaceGlobs(rootJson: Record<string, unknown>): string[] {
    const ws = rootJson.workspaces;
    if (Array.isArray(ws)) return ws.filter((g): g is string => typeof g === 'string');
    if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) {
        return (ws as { packages: unknown[] }).packages.filter((g): g is string => typeof g === 'string');
    }
    return [];
}

/**
 * The manifests a migration run may need to update: the nearest package.json walking
 * up from the target directory, plus every workspace-member manifest it declares
 * (npm/yarn/bun `workspaces` and pnpm-workspace.yaml), so monorepo members do not
 * keep a stale v1 dependency the root swap never sees.
 */
export function discoverManifests(targetDir: string): ManifestInfo[] {
    const rootManifest = findPackageJson(targetDir);
    if (!rootManifest) return [];
    const rootDir = path.dirname(rootManifest);
    const manifests: ManifestInfo[] = [{ dir: toPosix(rootDir), path: rootManifest }];

    const rootJson = readJson(rootManifest)?.json ?? {};
    const memberGlobs = [...npmWorkspaceGlobs(rootJson), ...pnpmWorkspaceGlobs(rootDir)];
    if (memberGlobs.length === 0) return manifests;

    const memberDirs = fg.sync(memberGlobs, {
        cwd: rootDir,
        onlyDirectories: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore: ['**/node_modules/**'],
        absolute: true
    });
    for (const dir of memberDirs) {
        const manifest = path.join(dir, 'package.json');
        if (existsSync(manifest) && manifest !== rootManifest) {
            manifests.push({ dir: toPosix(dir), path: manifest });
        }
    }
    return manifests;
}

/** Longest-prefix owner of a file among the discovered manifest directories. */
export function ownerManifest(filePath: string, manifests: readonly ManifestInfo[]): ManifestInfo | undefined {
    const posixFile = toPosix(filePath);
    let best: ManifestInfo | undefined;
    for (const m of manifests) {
        const dir = toPosix(m.dir);
        const prefix = dir.endsWith('/') ? dir : dir + '/';
        if (posixFile.startsWith(prefix) && (!best || dir.length > (best ? toPosix(best.dir).length : 0))) {
            best = m;
        }
    }
    return best;
}

function zodWarning(deps: Record<string, string> | undefined, devDeps: Record<string, string> | undefined): string | undefined {
    const range = deps?.zod ?? devDeps?.zod;
    if (range !== undefined && zodRangeTooOld(range)) {
        return (
            `zod range '${range}' cannot satisfy v2's floor: zod >=4.2.0 is required. ` +
            `An older range installs and typechecks cleanly and only fails at runtime ` +
            `(the server starts normally and the first tools/list reports the failure).`
        );
    }
    return undefined;
}

function declaresV1(manifestPath: string): boolean {
    const parsed = readJson(manifestPath);
    if (!parsed) return false;
    const deps = parsed.json.dependencies as Record<string, string> | undefined;
    const devDeps = parsed.json.devDependencies as Record<string, string> | undefined;
    return (deps !== undefined && V1_PACKAGE in deps) || (devDeps !== undefined && V1_PACKAGE in devDeps);
}

/**
 * Swap the v1 SDK dependency for the v2 packages in every manifest that declares it.
 *
 * The v2 additions come from the **post-transform** import state of the files each
 * manifest owns (`usedByManifest`), not from what was rewritten in this run — so a
 * partially or fully pre-migrated package still gets the v2 packages its imports
 * need when its v1 dependency is removed.
 */
export function updatePackageJson(
    manifests: readonly ManifestInfo[],
    usedByManifest: ReadonlyMap<string, ReadonlySet<string>>,
    dryRun: boolean
): PackageJsonChange[] {
    const changes: PackageJsonChange[] = [];

    // Hoisted-dependency roll-up: a workspace member without its own v1 dependency
    // relies on an ancestor manifest (usually the root) for SDK resolution, so its
    // usage must count toward the nearest ancestor that DOES declare the v1 SDK —
    // otherwise a hoisted monorepo would get the v1 dependency removed from the
    // root with none of the v2 replacements added.
    const effectiveUsed = new Map<string, Set<string>>();
    for (const m of manifests) {
        effectiveUsed.set(m.path, new Set(usedByManifest.get(m.path)));
    }
    const byDirLengthDesc = [...manifests].toSorted((a, b) => b.dir.length - a.dir.length);
    for (const m of byDirLengthDesc) {
        if (declaresV1(m.path)) continue;
        const used = effectiveUsed.get(m.path);
        if (!used || used.size === 0) continue;
        const ancestor = byDirLengthDesc.find(a => a !== m && (m.dir + path.sep).startsWith(a.dir + path.sep) && declaresV1(a.path));
        if (ancestor) {
            const target = effectiveUsed.get(ancestor.path);
            for (const pkg of used) target?.add(pkg);
        }
    }

    for (const manifest of manifests) {
        const parsed = readJson(manifest.path);
        if (!parsed) continue;
        const { raw, json: pkgJson } = parsed;
        const deps = pkgJson.dependencies as Record<string, string> | undefined;
        const devDeps = pkgJson.devDependencies as Record<string, string> | undefined;

        const inDeps = deps !== undefined && V1_PACKAGE in deps;
        const inDevDeps = devDeps !== undefined && V1_PACKAGE in devDeps;
        const warning = zodWarning(deps, devDeps);

        if (!inDeps && !inDevDeps) {
            if (warning) {
                changes.push({ added: [], removed: [], packageJsonPath: manifest.path, warnings: [warning] });
            }
            continue;
        }

        const used = effectiveUsed.get(manifest.path) ?? new Set<string>();
        const packagesToAdd = [...new Set([...used].map(pkg => normalizeToRoot(pkg)))].filter(
            pkg => !PRIVATE_PACKAGES.has(pkg) && pkg in V2_PACKAGE_VERSIONS
        );

        // If v1 SDK was in both sections, prefer dependencies.
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

        if (!dryRun) {
            const indent = detectIndent(raw);
            const trailingNewline = raw.endsWith('\n');
            let output = JSON.stringify(pkgJson, null, indent);
            if (trailingNewline) output += '\n';
            writeFileSync(manifest.path, output);
        }

        changes.push({
            added: added.toSorted(),
            removed: [V1_PACKAGE],
            packageJsonPath: manifest.path,
            ...(warning !== undefined && { warnings: [warning] })
        });
    }

    return changes;
}
