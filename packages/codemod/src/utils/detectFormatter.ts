import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** A code formatter the codemod can recommend running after a migration. */
export interface DetectedFormatter {
    /** Display name, e.g. `Prettier`. */
    name: string;
    /** Executable name, e.g. `prettier`. */
    bin: string;
    /** Arguments that write formatting in place; changed file paths are appended after these. */
    writeArgs: readonly string[];
}

const BIOME_CONFIG_FILES = ['biome.json', 'biome.jsonc'];
const PRETTIER_CONFIG_FILES = [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.json5',
    '.prettierrc.yaml',
    '.prettierrc.yml',
    '.prettierrc.toml',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.mjs',
    '.prettierrc.ts',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs',
    'prettier.config.ts'
];
const ESLINT_CONFIG_FILES = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    'eslint.config.cts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml'
];

// Precedence order: a configured dedicated formatter wins over ESLint's --fix.
const FORMATTERS = {
    biome: { name: 'Biome', bin: 'biome', writeArgs: ['format', '--write'] },
    prettier: { name: 'Prettier', bin: 'prettier', writeArgs: ['--write'] },
    eslint: { name: 'ESLint', bin: 'eslint', writeArgs: ['--fix'] }
} as const satisfies Record<string, DetectedFormatter>;

function hasAnyFile(dir: string, files: readonly string[]): boolean {
    return files.some(file => existsSync(path.join(dir, file)));
}

interface PackageJsonSignals {
    prettier: boolean;
    eslint: boolean;
}

function readPackageJsonSignals(dir: string): PackageJsonSignals {
    const pkgJsonPath = path.join(dir, 'package.json');
    if (!existsSync(pkgJsonPath)) return { prettier: false, eslint: false };
    try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
        const allDeps = {
            ...(pkgJson.dependencies as Record<string, string> | undefined),
            ...(pkgJson.devDependencies as Record<string, string> | undefined)
        };
        return {
            prettier: 'prettier' in pkgJson || 'prettier' in allDeps,
            eslint: 'eslint' in allDeps
        };
    } catch {
        return { prettier: false, eslint: false };
    }
}

/**
 * Walks up from `startDir` — bounded to the repository, stopping at a `.git`
 * directory so a global config in `$HOME` is never matched — looking for a
 * configured code formatter, so the CLI can suggest the right "format your
 * changed files" command after a migration.
 *
 * Detection is config-based and runs nothing. When multiple formatters are
 * configured, precedence is Biome > Prettier > ESLint.
 *
 * @returns the detected formatter, or `null` if none is configured.
 */
export function detectFormatter(startDir: string): DetectedFormatter | null {
    let dir = path.resolve(startDir);
    const root = path.parse(dir).root;
    const found = { biome: false, prettier: false, eslint: false };

    while (true) {
        if (hasAnyFile(dir, BIOME_CONFIG_FILES)) found.biome = true;
        if (hasAnyFile(dir, PRETTIER_CONFIG_FILES)) found.prettier = true;
        if (hasAnyFile(dir, ESLINT_CONFIG_FILES)) found.eslint = true;

        const signals = readPackageJsonSignals(dir);
        if (signals.prettier) found.prettier = true;
        if (signals.eslint) found.eslint = true;

        if (existsSync(path.join(dir, '.git')) || dir === root) break;
        dir = path.dirname(dir);
    }

    if (found.biome) return FORMATTERS.biome;
    if (found.prettier) return FORMATTERS.prettier;
    if (found.eslint) return FORMATTERS.eslint;
    return null;
}
