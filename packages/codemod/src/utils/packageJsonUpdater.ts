import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';

import { V2_PACKAGE_VERSIONS } from '../generated/versions';
import type { PackageJsonChange } from '../types';
import { findPackageJson } from './projectAnalyzer';

const V1_PACKAGE = '@modelcontextprotocol/sdk';
const PRIVATE_PACKAGES = new Set(['@modelcontextprotocol/core-internal']);

type ZodSegmentVerdict = 'ok' | 'v3' | 'v4pre42';

/**
 * Classify one `||` alternative of a zod range by the highest version it can resolve
 * to. 'ok' = can reach >=4.2 (satisfies v2's floor); 'v3' = resolves into 3.x;
 * 'v4pre42' = resolves into 4.0/4.1 (typings predate `~standard.jsonSchema`, so
 * registration calls fail type-checking).
 */
function classifyZodSegment(segment: string): ZodSegmentVerdict {
    const seg = segment
        .replace(/^(?:workspace:|npm:)/, '')
        .replace(/^[=\s]+/, '')
        .trim();
    if (seg === '' || seg === '*' || seg === 'x' || seg === 'latest') return 'ok';

    const classifyUpper = (major: number, minor: number | undefined, inclusive: boolean): ZodSegmentVerdict => {
        if (major > 4) return 'ok';
        if (major < 4) return 'v3';
        // major === 4: an upper bound below 4.2 caps resolution at 4.0/4.1; `<4` and
        // `<4.0` cap it in 3.x. A bare inclusive major (`<=4`, `… - 4`) is an
        // X-range upper bound — it admits every 4.x release and satisfies the floor.
        if (minor === undefined) return inclusive ? 'ok' : 'v3';
        if (minor === 0 && inclusive === false) return 'v3';
        if (minor < 2) return 'v4pre42';
        if (minor === 2 && inclusive === false) return 'v4pre42';
        return 'ok';
    };

    // Hyphen range `A - B`: resolution maxes at B (inclusive).
    const hyphen = seg.match(/^\S+\s+-\s+v?(\d+)(?:\.(\d+))?/);
    if (hyphen) {
        return classifyUpper(Number(hyphen[1]), hyphen[2] === undefined ? undefined : Number(hyphen[2]), true);
    }

    // Comparator sets: an upper `<`/`<=` bound caps resolution; a floor with no upper
    // bound resolves to the latest release.
    const upper = seg.match(/<(=?)\s*v?(\d+)(?:\.(\d+))?/);
    if (upper) {
        return classifyUpper(Number(upper[2]), upper[3] === undefined ? undefined : Number(upper[3]), upper[1] === '=');
    }
    if (seg.startsWith('>')) return 'ok';

    // Caret: `^3.x` cannot reach 4; `^4.x` allows everything below 5.
    const caret = seg.match(/^\^\s*v?(\d+)/);
    if (caret) return Number(caret[1]) < 4 ? 'v3' : 'ok';

    // Tilde and bare/exact versions: `~4.1`/`4.1.x`/`=4.0.2` stay below 4.2; a bare
    // major (`4`, `~4`, `4.x`) allows the whole major line.
    const plain = seg.match(/^~?\s*v?(\d+)(?:\.(x|\*|\d+))?/);
    if (plain) {
        const major = Number(plain[1]);
        if (major < 4) return 'v3';
        if (major > 4) return 'ok';
        const minorRaw = plain[2];
        if (minorRaw === undefined || minorRaw === 'x' || minorRaw === '*') return 'ok';
        return Number(minorRaw) < 2 ? 'v4pre42' : 'ok';
    }
    return 'ok';
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
    // Workspace members live under the root that declares them; a glob that
    // resolves elsewhere (an absolute pattern, a parent reference) is outside this
    // run's scope and is not reported.
    const resolvedRoot = path.resolve(rootDir);
    for (const dir of memberDirs) {
        if (!path.resolve(dir).startsWith(resolvedRoot + path.sep)) continue;
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

function zodWarning(...depSections: (Record<string, string> | undefined)[]): string | undefined {
    const range = depSections.find(section => section?.zod !== undefined)?.zod;
    if (range === undefined) return undefined;
    // Every `||` alternative must fall short of the floor before we warn — `^3.25 || ^4.5` resolves fine.
    const verdicts = range.split('||').map(seg => classifyZodSegment(seg));
    if (verdicts.length === 0 || verdicts.includes('ok')) return undefined;
    const floor = `zod range '${range}' cannot satisfy v2's floor: zod >=4.2.0 is required. `;
    if (verdicts.every(v => v === 'v4pre42')) {
        return (
            floor +
            `This range resolves to zod 4.0-4.1, which predates ~standard.jsonSchema: registerTool/registerPrompt ` +
            `calls fail type-checking (TS2769: no overload matches), and plain-JavaScript projects run through a ` +
            `bundled fallback that drops .describe() field descriptions.`
        );
    }
    return (
        floor +
        `An older range installs cleanly and then, depending on the zod entry point your code imports, ` +
        `fails type-checking (zod/v4 subpath) or only fails at runtime ` +
        `(main-entry imports: the server starts normally and the first tools/list reports the failure).`
    );
}

interface ParsedManifest {
    raw: string;
    json: Record<string, unknown>;
    deps?: Record<string, string>;
    devDeps?: Record<string, string>;
    peerDeps?: Record<string, string>;
    optionalDeps?: Record<string, string>;
    declaresV1: boolean;
}

function parseManifest(manifestPath: string): ParsedManifest | undefined {
    const parsed = readJson(manifestPath);
    if (!parsed) return undefined;
    const deps = parsed.json.dependencies as Record<string, string> | undefined;
    const devDeps = parsed.json.devDependencies as Record<string, string> | undefined;
    const peerDeps = parsed.json.peerDependencies as Record<string, string> | undefined;
    const optionalDeps = parsed.json.optionalDependencies as Record<string, string> | undefined;
    return {
        raw: parsed.raw,
        json: parsed.json,
        deps,
        devDeps,
        peerDeps,
        optionalDeps,
        declaresV1: (deps !== undefined && V1_PACKAGE in deps) || (devDeps !== undefined && V1_PACKAGE in devDeps)
    };
}

/**
 * Swap the v1 SDK dependency for the v2 packages in the **nearest** manifest (the
 * first entry of `manifests`), and report — without modifying — the same edit for
 * every other manifest that declares the v1 SDK, so workspace members never receive
 * writes the user did not point the codemod at.
 *
 * The v2 additions come from the **post-transform** import state of the files each
 * manifest owns (`usedByManifest`), not from what was rewritten in this run — so a
 * partially or fully pre-migrated package still gets the v2 packages its imports
 * need when its v1 dependency is removed.
 */
const ZOD_RANGE = '^4.2.0';
const TEST_PATH_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

function writeManifest(manifestPath: string, raw: string, pkgJson: Record<string, unknown>): void {
    const indent = detectIndent(raw);
    let output = JSON.stringify(pkgJson, null, indent);
    if (raw.endsWith('\n')) output += '\n';
    writeFileSync(manifestPath, output);
}

export function updatePackageJson(
    manifests: readonly ManifestInfo[],
    usedByManifest: ReadonlyMap<string, ReadonlySet<string>>,
    dryRun: boolean,
    zodInjectedByManifest: ReadonlyMap<string, readonly string[]> = new Map()
): PackageJsonChange[] {
    const changes: PackageJsonChange[] = [];
    const nearestPath = manifests[0]?.path;

    // Each manifest is read and parsed exactly once; every later step (v1 checks,
    // roll-up, edits) works from this shared view.
    const parsedByPath = new Map<string, ParsedManifest>();
    for (const m of manifests) {
        const parsed = parseManifest(m.path);
        if (parsed) parsedByPath.set(m.path, parsed);
    }

    // Hoisted-dependency roll-up: a workspace member without its own v1 dependency
    // relies on an ancestor manifest (usually the root) for SDK resolution, so its
    // usage must count toward the nearest ancestor that DOES declare the v1 SDK —
    // otherwise a hoisted monorepo would get the v1 dependency removed from the
    // root with none of the v2 replacements added.
    const effectiveUsed = new Map<string, Set<string>>();
    const hoistNotes = new Map<string, string[]>();
    for (const m of manifests) {
        effectiveUsed.set(m.path, new Set(usedByManifest.get(m.path)));
    }
    const v1Ancestors = manifests.filter(a => parsedByPath.get(a.path)?.declaresV1 === true);

    // zod-injected files follow the same hoisting rule as usage: a member without its
    // own v1 dependency takes part through its nearest v1-declaring ancestor, so its
    // injections must surface there or the add is silently lost.
    const effectiveZodInjected = new Map<string, string[]>();
    for (const [manifestPath, files] of zodInjectedByManifest) {
        const declaresV1Here = parsedByPath.get(manifestPath)?.declaresV1 === true;
        const home = declaresV1Here ? manifestPath : (ownerManifest(manifestPath, v1Ancestors)?.path ?? manifestPath);
        let bucket = effectiveZodInjected.get(home);
        if (!bucket) {
            bucket = [];
            effectiveZodInjected.set(home, bucket);
        }
        bucket.push(...files);
    }
    for (const m of manifests) {
        if (parsedByPath.get(m.path)?.declaresV1 === true) continue;
        const used = effectiveUsed.get(m.path);
        if (!used || used.size === 0) continue;
        // A member only participates when its imports map to publishable v2 packages.
        const contributes = [...used]
            .map(pkg => normalizeToRoot(pkg))
            .some(pkg => !PRIVATE_PACKAGES.has(pkg) && pkg in V2_PACKAGE_VERSIONS);
        if (!contributes) continue;
        const ancestor = ownerManifest(m.path, v1Ancestors);
        if (ancestor) {
            const target = effectiveUsed.get(ancestor.path);
            for (const pkg of used) target?.add(pkg);
            let notes = hoistNotes.get(ancestor.path);
            if (!notes) {
                notes = [];
                hoistNotes.set(ancestor.path, notes);
            }
            notes.push(
                `workspace member ${toPosix(path.relative(ancestor.dir, m.dir)) || '.'} has no own ${V1_PACKAGE} dependency ` +
                    `and resolves the SDK through this manifest; its imports were included when computing the v2 dependency set`
            );
        }
    }

    for (const manifest of manifests) {
        const parsed = parsedByPath.get(manifest.path);
        if (!parsed) continue;
        const { raw, json: pkgJson, deps, devDeps, peerDeps, optionalDeps } = parsed;

        const inDeps = deps !== undefined && V1_PACKAGE in deps;
        const inDevDeps = devDeps !== undefined && V1_PACKAGE in devDeps;
        const warning = zodWarning(deps, devDeps, peerDeps, optionalDeps);

        const declaresAnyV2 = Object.keys({ ...deps, ...devDeps }).some(dep => dep in V2_PACKAGE_VERSIONS);
        const usesV2 = (effectiveUsed.get(manifest.path)?.size ?? 0) > 0;
        const isNearest = manifest.path === nearestPath;

        // The file-level `import { z } from 'zod'` injection promises a manifest edit;
        // it must land even when this manifest never declared the v1 SDK (a member
        // already on v2, or a sub-tree target whose v1 dependency lives outside it).
        const injectedFiles = effectiveZodInjected.get(manifest.path);
        // A peer- or optional-declared zod is still a declaration: adding a direct
        // dependency on top of it would duplicate (and possibly conflict with) the
        // package's own contract.
        const declaresZod = [deps, devDeps, peerDeps, optionalDeps].some(section => section !== undefined && 'zod' in section);
        const needsInjectedZod = injectedFiles !== undefined && injectedFiles.length > 0 && !declaresZod;
        const addInjectedZod = (targetSection: 'dependencies' | 'devDependencies'): 'dependencies' | 'devDependencies' => {
            // Classify against the path RELATIVE to the package — a test/ segment in
            // some ancestor directory (CI checkout dirs) must not demote the dep.
            const testOnly = injectedFiles!.every(file => TEST_PATH_RE.test(toPosix(path.relative(manifest.dir, file))));
            const section = testOnly ? 'devDependencies' : targetSection;
            if (!pkgJson[section]) {
                pkgJson[section] = {};
            }
            (pkgJson[section] as Record<string, string>)['zod'] = ZOD_RANGE;
            return section;
        };

        if (!inDeps && !inDevDeps) {
            if (needsInjectedZod) {
                addInjectedZod('dependencies');
                if (isNearest && !dryRun) {
                    writeManifest(manifest.path, raw, pkgJson);
                }
                changes.push({ added: ['zod'], removed: [], packageJsonPath: manifest.path, applied: isNearest });
                continue;
            }
            // The zod note only matters for manifests that take part in the migration:
            // they declare a v2 package, or their files import one (hoisted members).
            if (warning && (declaresAnyV2 || usesV2)) {
                changes.push({ added: [], removed: [], packageJsonPath: manifest.path, applied: false, warnings: [warning] });
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

        // Wrapped raw shapes had `import { z } from 'zod'` injected — under strict
        // node_modules layouts the owning package must declare zod itself, so a
        // zod-less manifest gets it added (devDependencies when only tests import it).
        if (needsInjectedZod) {
            addInjectedZod(targetSection);
            added.push('zod');
        }

        if (inDeps) delete deps![V1_PACKAGE];
        if (inDevDeps) delete devDeps![V1_PACKAGE];

        // Only the nearest manifest is written; the others are reported so the user
        // applies (or deliberately skips) each workspace-member edit themselves.
        if (isNearest && !dryRun) {
            writeManifest(manifest.path, raw, pkgJson);
        }

        const notes = hoistNotes.get(manifest.path);
        changes.push({
            added: added.toSorted(),
            removed: [V1_PACKAGE],
            packageJsonPath: manifest.path,
            applied: isNearest,
            ...(notes !== undefined && { notes }),
            ...(warning !== undefined && (added.length > 0 || declaresAnyV2 || usesV2) && { warnings: [warning] })
        });
    }

    return changes;
}
