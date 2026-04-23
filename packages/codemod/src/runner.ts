import { Project } from 'ts-morph';

import type { Diagnostic, FileResult, Migration, RunnerOptions, RunnerResult } from './types.js';
import { error } from './utils/diagnostics.js';
import { analyzeProject } from './utils/projectAnalyzer.js';

export function run(migration: Migration, options: RunnerOptions): RunnerResult {
    const context = analyzeProject(options.targetDir);

    const enabledTransforms = options.transforms
        ? migration.transforms.filter(t => options.transforms!.includes(t.id))
        : migration.transforms;

    const project = new Project({
        tsConfigFilePath: undefined,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: {
            allowJs: true,
            noEmit: true
        }
    });

    const globPattern = `${options.targetDir}/**/*.{ts,tsx,mts}`;
    const ignorePatterns = [
        '**/node_modules/**',
        '**/dist/**',
        '**/.git/**',
        '**/build/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/coverage/**',
        '**/__generated__/**',
        ...(options.ignore ?? [])
    ];

    const allPatterns = [globPattern];
    for (const ignore of ignorePatterns) {
        allPatterns.push(`!${ignore}`);
    }
    project.addSourceFilesAtPaths(allPatterns);

    const sourceFiles = project.getSourceFiles().filter(sf => {
        const fp = sf.getFilePath();
        return !fp.includes('/node_modules/') && !fp.includes('/dist/');
    });
    const fileResults: FileResult[] = [];
    const allDiagnostics: Diagnostic[] = [];
    let totalChanges = 0;
    let filesChanged = 0;

    for (const sourceFile of sourceFiles) {
        let fileChanges = 0;
        const fileDiagnostics: Diagnostic[] = [];

        try {
            for (const transform of enabledTransforms) {
                const result = transform.apply(sourceFile, context);
                fileChanges += result.changesCount;
                fileDiagnostics.push(...result.diagnostics);
            }
        } catch (error_) {
            const filePath = sourceFile.getFilePath();
            fileDiagnostics.push(error(filePath, 1, `Transform failed: ${error_ instanceof Error ? error_.message : String(error_)}`));
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

    if (!options.dryRun) {
        project.saveSync();
    }

    return {
        filesChanged,
        totalChanges,
        diagnostics: allDiagnostics,
        fileResults
    };
}
