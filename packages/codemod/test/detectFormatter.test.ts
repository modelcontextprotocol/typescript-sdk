import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { detectFormatter } from '../src/utils/detectFormatter.js';

let tempDir: string;

function createTempDir(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-formatter-'));
    return tempDir;
}

function writePkg(dir: string, pkg: Record<string, unknown>): void {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

describe('detectFormatter', () => {
    it('returns null when no formatter is configured', () => {
        const dir = createTempDir();
        writePkg(dir, { devDependencies: { typescript: '^5' } });

        expect(detectFormatter(dir)).toBeNull();
    });

    it('detects Prettier from a config file', () => {
        const dir = createTempDir();
        writeFileSync(path.join(dir, 'prettier.config.mjs'), 'export default {};');

        const result = detectFormatter(dir);
        expect(result?.name).toBe('Prettier');
        expect(result?.bin).toBe('prettier');
        expect(result?.writeArgs).toEqual(['--write']);
    });

    it('detects Prettier from the "prettier" key in package.json', () => {
        const dir = createTempDir();
        writePkg(dir, { prettier: { singleQuote: false } });

        expect(detectFormatter(dir)?.name).toBe('Prettier');
    });

    it('detects Prettier from devDependencies', () => {
        const dir = createTempDir();
        writePkg(dir, { devDependencies: { prettier: '^3' } });

        expect(detectFormatter(dir)?.name).toBe('Prettier');
    });

    it('detects Biome from biome.json', () => {
        const dir = createTempDir();
        writeFileSync(path.join(dir, 'biome.json'), '{}');

        const result = detectFormatter(dir);
        expect(result?.name).toBe('Biome');
        expect(result?.bin).toBe('biome');
        expect(result?.writeArgs).toEqual(['format', '--write']);
    });

    it('does not detect dprint — a lone dprint.json yields null', () => {
        const dir = createTempDir();
        writeFileSync(path.join(dir, 'dprint.json'), '{}');

        expect(detectFormatter(dir)).toBeNull();
    });

    it('detects ESLint when only ESLint is configured', () => {
        const dir = createTempDir();
        writeFileSync(path.join(dir, 'eslint.config.js'), 'export default [];');

        const result = detectFormatter(dir);
        expect(result?.name).toBe('ESLint');
        expect(result?.bin).toBe('eslint');
        expect(result?.writeArgs).toEqual(['--fix']);
    });

    it('prefers Prettier over ESLint when both are configured (the common prettier-plugin case)', () => {
        const dir = createTempDir();
        writeFileSync(path.join(dir, 'eslint.config.js'), 'export default [];');
        writeFileSync(path.join(dir, 'prettier.config.mjs'), 'export default {};');

        expect(detectFormatter(dir)?.name).toBe('Prettier');
    });

    it('prefers Biome over Prettier when both are configured', () => {
        const dir = createTempDir();
        writeFileSync(path.join(dir, 'biome.json'), '{}');
        writeFileSync(path.join(dir, 'prettier.config.mjs'), 'export default {};');

        expect(detectFormatter(dir)?.name).toBe('Biome');
    });

    it('walks up directory levels to find the formatter (monorepo layout)', () => {
        const dir = createTempDir();
        const src = path.join(dir, 'packages', 'mcp', 'src');
        mkdirSync(src, { recursive: true });
        writeFileSync(path.join(dir, 'prettier.config.mjs'), 'export default {};');

        expect(detectFormatter(src)?.name).toBe('Prettier');
    });

    it('stops at the .git boundary and does not detect config above the repo root', () => {
        const dir = createTempDir();
        const src = path.join(dir, 'project', 'src');
        mkdirSync(src, { recursive: true });
        mkdirSync(path.join(dir, 'project', '.git'), { recursive: true });
        // Config lives above the repo root — must not be picked up.
        writeFileSync(path.join(dir, 'prettier.config.mjs'), 'export default {};');

        expect(detectFormatter(src)).toBeNull();
    });
});
