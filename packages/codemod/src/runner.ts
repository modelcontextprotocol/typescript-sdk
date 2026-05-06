import { Project } from 'ts-morph';

import type { Diagnostic, FileResult, Migration, RunnerOptions, RunnerResult } from './types.js';
import { error } from './utils/diagnostics.js';
import { updatePackageJson } from './utils/packageJsonUpdater.js';
import { analyzeProject } from './utils/projectAnalyzer.js';

function escapeGlobPath(p: string): string {
    return p.replaceAll(/[[\]{}()*?!@#]/g, String.raw`\$&`);
}

export function run(migration: Migration, options: RunnerOptions): RunnerResult {
    const context = analyzeProject(options.targetDir);

    let enabledTransforms = migration.transforms;
    if (options.transforms) {
        const validIds = new Set(migration.transforms.map(t => t.id));
        const unknown = options.transforms.filter(id => !validIds.has(id));
        if (unknown.length > 0) {
            throw new Error(
                `Unknown transform ID(s): ${unknown.join(', ')}. ` +
                    `Available: ${[...validIds].join(', ')}. Use --list to see all transforms.`
            );
        }
        enabledTransforms = migration.transforms.filter(t => options.transforms!.includes(t.id));
    }

    const project = new Project({
        tsConfigFilePath: undefined,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: {
            allowJs: true,
            noEmit: true
        }
    });

    const globPattern = `${escapeGlobPath(options.targetDir)}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`;
    const ignorePatterns = [
        '**/node_modules/**',
        '**/dist/**',
        '**/.git/**',
        '**/build/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/coverage/**',
        '**/__generated__/**',
        '**/*.d.ts',
        '**/*.d.mts',
        '**/*.d.cts',
        ...(options.ignore ?? [])
    ];

    const allPatterns = [globPattern];
    for (const ignore of ignorePatterns) {
        allPatterns.push(`!${ignore}`);
    }
    project.addSourceFilesAtPaths(allPatterns);

    const sourceFiles = project.getSourceFiles().filter(sf => {
        const fp = sf.getFilePath();
        if (fp.includes('/node_modules/') || fp.includes('/dist/')) return false;
        if (fp.endsWith('.d.ts') || fp.endsWith('.d.mts') || fp.endsWith('.d.cts')) return false;
        return true;
    });
    const fileResults: FileResult[] = [];
    const allDiagnostics: Diagnostic[] = [];
    const allUsedPackages = new Set<string>();
    let totalChanges = 0;
    let filesChanged = 0;

    for (const sourceFile of sourceFiles) {
        let fileChanges = 0;
        const fileDiagnostics: Diagnostic[] = [];
        const originalText = sourceFile.getFullText();

        const fileUsedPackages = new Set<string>();
        try {
            for (const transform of enabledTransforms) {
                const result = transform.apply(sourceFile, context);
                fileChanges += result.changesCount;
                fileDiagnostics.push(...result.diagnostics);
                if (result.usedPackages) {
                    for (const pkg of result.usedPackages) {
                        fileUsedPackages.add(pkg);
                    }
                }
            }
            for (const pkg of fileUsedPackages) {
                allUsedPackages.add(pkg);
            }
        } catch (error_) {
            const filePath = sourceFile.getFilePath();
            fileDiagnostics.length = 0;
            fileDiagnostics.push(error(filePath, 1, `Transform failed: ${error_ instanceof Error ? error_.message : String(error_)}`));
            sourceFile.replaceWithText(originalText);
            fileChanges = 0;
            fileUsedPackages.clear();
        }

        if (fileChanges > 0 || fileDiagnostics.length > 0) {
            if (fileChanges > 0) {
                filesChanged++;
                totalChanges += fileChanges;
            }
            fileResults.push({
                filePath: sourceFile.getFilePath(),
                changes: fileChanges,
                diagnostics: fileDiagnostics
            });
            allDiagnostics.push(...fileDiagnostics);
        }
    }

    const hasImportsTransform = enabledTransforms.some(t => t.id === 'imports' || t.id === 'mock-paths');
    const packageJsonChanges = hasImportsTransform
        ? updatePackageJson(options.targetDir, allUsedPackages, options.dryRun ?? false)
        : undefined;

    // Per-file mutations are atomic: if any transform fails, the file is rolled back to its
    // original state and an error diagnostic is emitted.
    if (!options.dryRun) {
        project.saveSync();
    }

    return {
        filesChanged,
        totalChanges,
        diagnostics: allDiagnostics,
        fileResults,
        packageJsonChanges
    };
}
