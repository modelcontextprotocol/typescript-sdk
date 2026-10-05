import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const tscCli = join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');

type PackageExport = Record<string, string>;
type PackageManifest = {
    exports: Record<string, PackageExport>;
};
type PackResult = {
    files: Array<{ path: string }>;
};

function runNode(script: string, args: string[], cwd = repositoryRoot): string {
    return execFileSync(process.execPath, [script, ...args], {
        cwd,
        encoding: 'utf8'
    });
}

function runNpm(args: string[], cwd = repositoryRoot): string {
    return runNode(npmCli, args, cwd);
}

describe('published package artifacts', () => {
    let packageRoot: string;
    let packedPaths: Set<string>;

    beforeAll(() => {
        packageRoot = mkdtempSync(join(tmpdir(), 'mcp-sdk-package-'));
        runNode(tscCli, ['-p', join(repositoryRoot, 'tsconfig.prod.json'), '--outDir', join(packageRoot, 'dist', 'esm')]);
        runNode(tscCli, ['-p', join(repositoryRoot, 'tsconfig.cjs.json'), '--outDir', join(packageRoot, 'dist', 'cjs')]);
        writeFileSync(join(packageRoot, 'package.json'), readFileSync(join(repositoryRoot, 'package.json')));

        const [packResult] = JSON.parse(runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], packageRoot)) as PackResult[];
        packedPaths = new Set(packResult.files.map(file => file.path));
    }, 120_000);

    afterAll(() => {
        rmSync(packageRoot, { recursive: true, force: true });
    });

    test('does not contain compiled example entry points', () => {
        const compiledExamples = [...packedPaths].filter(path => /^dist\/(esm|cjs)\/examples\//.test(path));

        expect(compiledExamples).toEqual([]);
    });

    test('contains every supported explicit subpath export target', () => {
        const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest;
        const explicitExportTargets = Object.entries(manifest.exports)
            .filter(([subpath]) => subpath !== '.' && subpath !== './*')
            .flatMap(([, conditions]) => Object.values(conditions))
            .map(target => target.replace(/^\.\//, ''));

        expect(explicitExportTargets.filter(target => !packedPaths.has(target))).toEqual([]);
    });

    test.each([
        'dist/esm/client/stdio.js',
        'dist/cjs/client/stdio.js',
        'dist/esm/server/stdio.js',
        'dist/cjs/server/stdio.js',
        'dist/esm/shared/protocol.js',
        'dist/cjs/shared/protocol.js'
    ])('keeps the supported wildcard subpath target %s', target => {
        expect(packedPaths).toContain(target);
    });
});
