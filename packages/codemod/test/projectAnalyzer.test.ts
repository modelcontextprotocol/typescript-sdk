import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { analyzeProject } from '../src/utils/projectAnalyzer.js';

let tempDir: string;

function createTempDir(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-analyzer-'));
    return tempDir;
}

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

describe('analyzeProject', () => {
    it('returns unknown when no package.json exists', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, '.git'), { recursive: true });
        mkdirSync(path.join(dir, 'src'), { recursive: true });

        const result = analyzeProject(path.join(dir, 'src'));
        expect(result.projectType).toBe('unknown');
    });

    it('finds package.json in parent directory', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/client': '^2.0.0' }
            })
        );

        const result = analyzeProject(path.join(dir, 'src'));
        expect(result.projectType).toBe('client');
    });

    it('finds package.json multiple levels up', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, 'src', 'lib', 'utils'), { recursive: true });
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/server': '^2.0.0' }
            })
        );

        const result = analyzeProject(path.join(dir, 'src', 'lib', 'utils'));
        expect(result.projectType).toBe('server');
    });

    it('stops walking at .git boundary', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, 'project', 'src'), { recursive: true });
        mkdirSync(path.join(dir, 'project', '.git'), { recursive: true });
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/client': '^2.0.0' }
            })
        );

        const result = analyzeProject(path.join(dir, 'project', 'src'));
        expect(result.projectType).toBe('unknown');
    });

    it('stops walking at node_modules boundary', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, 'project', 'src'), { recursive: true });
        mkdirSync(path.join(dir, 'project', 'node_modules'), { recursive: true });
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/client': '^2.0.0' }
            })
        );

        const result = analyzeProject(path.join(dir, 'project', 'src'));
        expect(result.projectType).toBe('unknown');
    });

    it('detects both client and server dependencies', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: {
                    '@modelcontextprotocol/client': '^2.0.0',
                    '@modelcontextprotocol/server': '^2.0.0'
                }
            })
        );

        const result = analyzeProject(dir);
        expect(result.projectType).toBe('both');
    });

    it('finds package.json at targetDir itself', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/server': '^2.0.0' }
            })
        );

        const result = analyzeProject(dir);
        expect(result.projectType).toBe('server');
    });
});
