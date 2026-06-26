import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Directories never descended into. Matches the runner's built-in ignore list. */
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'build', '.next', '.nuxt', 'coverage', '__generated__']);

/**
 * Convert a subset of glob syntax (`**`, `*`, `?`) to a `RegExp` so user `--ignore` patterns can be
 * applied to discovered file paths without depending on a glob library. Brace/extglob/character-class
 * syntax is not interpreted (escaped literally) — sufficient for the documented `--ignore` use cases
 * (e.g. a `generated` or `src/legacy` subtree).
 */
function globToRegExp(glob: string): RegExp {
    let re = '';
    let i = 0;
    while (i < glob.length) {
        const c = glob[i]!;
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**` — any path segment(s), including none. Absorb a following `/` so `**/x` matches `x`.
                re += '.*';
                i += 2;
                if (glob[i] === '/') i++;
                continue;
            }
            re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if (/[\\^$.|+()[\]{}]/.test(c)) {
            re += '\\' + c;
        } else {
            re += c;
        }
        i++;
    }
    return new RegExp(`^${re}$`);
}

/**
 * Extract bare directory names from `--ignore` globs that name a single path segment (optionally
 * wrapped in globstars on either side) so they can be pruned during directory descent rather than
 * only filtered post-walk. This is what makes `--ignore` actually skip a directory tree — without
 * it, a cyclic-symlink directory matched by `--ignore` would still be entered.
 */
function extractIgnoreDirNames(ignorePatterns: string[]): Set<string> {
    const names = new Set<string>();
    for (const p of ignorePatterns) {
        const m = /^(?:\*\*\/)?([^/*?[\]{}]+)(?:\/\*\*)?$/.exec(p);
        if (m) names.add(m[1]!);
    }
    return names;
}

export interface SourceWalkResult {
    sourceFiles: string[];
    /** Every `package.json` discovered under (or at) `targetDir`, excluding skipped directories. */
    packageJsonPaths: string[];
}

/**
 * Walk `targetDir` for source files and `package.json` manifests, applying ignore patterns during
 * directory descent and never following symlinks.
 *
 * Replaces ts-morph's `addSourceFilesAtPaths` glob, which (a) follows directory symlinks — so a pnpm
 * workspace with a cyclic intra-workspace dev-dependency (`pkg-a/node_modules/@scope/pkg-b → ../pkg-b`,
 * and back) recurses indefinitely and dies with `ELOOP` — and (b) applies negative globstar patterns
 * to matched files only, so `--ignore` cannot prune the descent that causes the crash.
 *
 * `package.json` discovery is folded into the same walk so a monorepo run can update every workspace
 * member that depends on the v1 SDK, not just the closest manifest to `targetDir`.
 */
export function collectSourceFiles(targetDir: string, userIgnorePatterns: string[] = []): SourceWalkResult {
    const ignoreDirNames = new Set([...SKIP_DIR_NAMES, ...extractIgnoreDirNames(userIgnorePatterns)]);
    const ignoreMatchers = userIgnorePatterns.map(p => globToRegExp(p));
    const root = path.resolve(targetDir);
    const sourceFiles: string[] = [];
    const packageJsonPaths: string[] = [];

    if (existsSync(path.join(root, 'package.json'))) {
        packageJsonPaths.push(path.join(root, 'package.json'));
    }

    const matchesUserIgnore = (rel: string): boolean => ignoreMatchers.some(m => m.test(rel));

    const visit = (dir: string): void => {
        let entries: import('node:fs').Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            // Never follow symlinks — pnpm represents intra-workspace deps as symlinks under
            // node_modules, and following them is the ELOOP crash. A symlinked source file inside the
            // user's own tree is rare enough that skipping it is the safer default.
            if (entry.isSymbolicLink()) continue;

            const full = path.join(dir, entry.name);
            const rel = path.relative(root, full).replaceAll('\\', '/');

            if (entry.isDirectory()) {
                if (ignoreDirNames.has(entry.name)) continue;
                if (matchesUserIgnore(rel) || matchesUserIgnore(rel + '/')) continue;
                visit(full);
            } else if (entry.isFile()) {
                if (entry.name === 'package.json') {
                    packageJsonPaths.push(full);
                    continue;
                }
                const ext = path.extname(entry.name);
                if (!SOURCE_EXTENSIONS.has(ext)) continue;
                if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.mts') || entry.name.endsWith('.d.cts')) continue;
                if (matchesUserIgnore(rel)) continue;
                sourceFiles.push(full);
            }
        }
    };

    visit(root);
    return { sourceFiles, packageJsonPaths };
}

/**
 * The leading comment block of a source file: every byte from offset 0 up to (but not including) the
 * first non-comment, non-whitespace character. Used by the runner to snapshot a file header before
 * transforms run, so it can be restored verbatim if a transform drops it (a JSDoc block header is
 * leading trivia of the first import declaration, and ts-morph removes it along with the node) or
 * displaces it (ts-morph's `insertImportDeclaration(0)` inserts at byte 0, ahead of any `//` header
 * lines that survived a removal by re-attaching to the next statement).
 */
export function extractFileHeader(text: string): string {
    let i = 0;
    while (i < text.length) {
        const c = text[i]!;
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
            i++;
            continue;
        }
        if (text.startsWith('//', i)) {
            const nl = text.indexOf('\n', i);
            i = nl === -1 ? text.length : nl + 1;
            continue;
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2);
            if (end === -1) break;
            i = end + 2;
            continue;
        }
        break;
    }
    return text.slice(0, i);
}
