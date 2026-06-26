import type { Node } from 'ts-morph';
import { Project, SyntaxKind } from 'ts-morph';

import type { Diagnostic, FileResult, Migration, PackageJsonChange, RunnerOptions, RunnerResult } from './types';
import { CODEMOD_ERROR_PREFIX, error } from './utils/diagnostics';
import { collectSourceFiles, extractFileHeader } from './utils/fileWalk';
import { applyPackageJsonUpdate, attributeUsedPackages } from './utils/packageJsonUpdater';
import { analyzeProject } from './utils/projectAnalyzer';

const LITERAL_NODE_KINDS = new Set([
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateHead,
    SyntaxKind.TemplateMiddle,
    SyntaxKind.TemplateTail,
    SyntaxKind.StringLiteral,
    SyntaxKind.JsxText
]);

function isInsideLiteral(node: Node | undefined): boolean {
    let current = node;
    while (current) {
        if (LITERAL_NODE_KINDS.has(current.getKind())) return true;
        current = current.getParent();
    }
    return false;
}

function insertDiagnosticComments(project: Project, fileResults: FileResult[]): number {
    let insertedCount = 0;

    for (const fr of fileResults) {
        const commentDiags = fr.diagnostics.filter(d => d.insertComment).toSorted((a, b) => b.line - a.line);

        if (commentDiags.length === 0) continue;

        const merged: { line: number; message: string }[] = [];
        for (const diag of commentDiags) {
            const prev = merged.at(-1);
            if (prev && prev.line === diag.line) {
                prev.message += ' | ' + diag.message;
            } else {
                merged.push({ line: diag.line, message: diag.message });
            }
        }

        const sf = project.getSourceFile(fr.filePath);
        if (!sf) continue;

        // `sourceText` and `lines` are computed once from the pre-insertion text.
        // Insertions below mutate sf, but we process in descending line order, so
        // each insertText only shifts positions above the next insertion point —
        // prior byte offsets stay valid.
        const sourceText = sf.getFullText();
        const lines = sourceText.split('\n');
        const lineEnding = sourceText.includes('\r\n') ? '\r\n' : '\n';

        for (const diag of merged) {
            const lineIndex = diag.line - 1;
            if (lineIndex < 0 || lineIndex >= lines.length) continue;

            if (lineIndex > 0 && lines[lineIndex - 1]!.includes(CODEMOD_ERROR_PREFIX)) continue;

            const indent = lines[lineIndex]!.match(/^(\s*)/)?.[1] ?? '';
            const safeMessage = diag.message.replaceAll('*/', '* /');
            const comment = `${indent}/* ${CODEMOD_ERROR_PREFIX} ${safeMessage} */`;

            const lineStart = lines.slice(0, lineIndex).reduce((sum, l) => sum + l.length + 1, 0);

            if (isInsideLiteral(sf.getDescendantAtPos(lineStart))) continue;

            sf.insertText(lineStart, comment + lineEnding);
            insertedCount++;
        }
    }

    return insertedCount;
}

/**
 * Restore the file's original leading comment block when a transform has dropped or displaced it.
 *
 * A JSDoc block header is leading trivia of the first import declaration; ts-morph drops it with
 * the node when that import is `remove()`d (the per-symbol split path in `importPaths`, and again in
 * `symbolRenames`/`removedApis` when the rewritten import is itself removed). A `//` line-comment
 * header instead survives a removal by re-attaching to the next statement, and a subsequent
 * `insertImportDeclaration(0)` lands at byte 0 — ahead of it. Both leave the file no longer prefixed
 * by its original header. We snapshot the header before transforms and, if it is no longer the file
 * prefix, strip any displaced copy and re-prepend the original verbatim. The per-transform restore in
 * `importPaths` handles the common case; this is the safety net for headers a later transform touches.
 */
function restoreFileHeader(sourceFile: import('ts-morph').SourceFile, originalHeader: string): void {
    if (originalHeader.trim() === '') return;
    const newText = sourceFile.getFullText();
    if (newText.startsWith(originalHeader)) return;

    let body = newText;
    const displacedAt = body.indexOf(originalHeader);
    if (displacedAt !== -1) {
        body = body.slice(0, displacedAt) + body.slice(displacedAt + originalHeader.length);
    }
    body = body.replace(/^[\r\n]+/, '');
    sourceFile.replaceWithText(originalHeader + body);
}

export function run(migration: Migration, options: RunnerOptions): RunnerResult {
    const context = analyzeProject(options.targetDir, options.prefer);

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

    // Own walk instead of ts-morph's `addSourceFilesAtPaths` glob: the glob follows directory symlinks
    // (so a pnpm workspace with cyclic intra-workspace dev-deps dies with ELOOP) and applies negative
    // patterns to matched files only (so `--ignore` cannot prune the descent that crashes). The walk
    // also discovers every workspace `package.json` so a monorepo run updates each member manifest.
    const { sourceFiles: sourceFilePaths, packageJsonPaths } = collectSourceFiles(options.targetDir, options.ignore ?? []);
    for (const fp of sourceFilePaths) {
        try {
            project.addSourceFileAtPath(fp);
        } catch {
            // Unreadable file — skip; matches the prior glob's silent-skip behaviour.
        }
    }
    const sourceFiles = project.getSourceFiles();

    const fileResults: FileResult[] = [];
    const allDiagnostics: Diagnostic[] = [];
    const perFileUsedPackages = new Map<string, Set<string>>();
    let totalChanges = 0;
    let filesChanged = 0;

    for (const sourceFile of sourceFiles) {
        let fileChanges = 0;
        const fileDiagnostics: Diagnostic[] = [];
        const originalText = sourceFile.getFullText();
        const originalHeader = extractFileHeader(originalText);

        const fileClaimedPackages = new Set<string>();
        try {
            for (const transform of enabledTransforms) {
                const result = transform.apply(sourceFile, context);
                fileChanges += result.changesCount;
                fileDiagnostics.push(...result.diagnostics);
                if (result.usedPackages) {
                    for (const pkg of result.usedPackages) {
                        fileClaimedPackages.add(pkg);
                    }
                }
            }
            // A transform records a package as "used" when it routes a binding there — but importPaths does
            // so the moment it rewrites an import, and later transforms (handlerRegistration,
            // schemaParamRemoval) routinely rewrite the schema usage away and delete that very import.
            // Honouring a claim whose import did not survive would add an unused dependency to package.json,
            // so a claim counts only when the FINAL file still references the specifier. Every claim
            // originates from a string literal the transform wrote (an import/export module specifier, or a
            // vi.mock()/dynamic import() argument), so a surviving string-literal match is the ground truth.
            const survivingSpecifiers = new Set<string>();
            for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
                survivingSpecifiers.add(literal.getLiteralValue());
            }
            const surviving = new Set<string>();
            for (const pkg of fileClaimedPackages) {
                if (survivingSpecifiers.has(pkg)) surviving.add(pkg);
            }
            perFileUsedPackages.set(sourceFile.getFilePath(), surviving);
        } catch (error_) {
            const filePath = sourceFile.getFilePath();
            fileDiagnostics.length = 0;
            fileDiagnostics.push(error(filePath, 1, `Transform failed: ${error_ instanceof Error ? error_.message : String(error_)}`));
            sourceFile.replaceWithText(originalText);
            fileChanges = 0;
            fileClaimedPackages.clear();
        }

        if (fileChanges > 0) restoreFileHeader(sourceFile, originalHeader);

        for (const d of fileDiagnostics) {
            if (d.resolveCurrentLine) {
                try {
                    d.line = d.resolveCurrentLine();
                } catch {
                    // Node was removed by a later transform; keep snapshot line
                }
                delete d.resolveCurrentLine;
            }
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

    const hasImportsTransform = enabledTransforms.some(t => t.id === 'imports');
    let packageJsonChanges: PackageJsonChange[] | undefined;
    if (hasImportsTransform) {
        const attributed = attributeUsedPackages(options.targetDir, packageJsonPaths, perFileUsedPackages);
        const changes: PackageJsonChange[] = [];
        for (const [pkgJsonPath, used] of attributed) {
            const change = applyPackageJsonUpdate(pkgJsonPath, used, options.dryRun ?? false);
            if (change) changes.push(change);
        }
        packageJsonChanges = changes.length > 0 ? changes : undefined;
    }

    // Per-file mutations are atomic: if any transform fails, the file is rolled back to its
    // original state and an error diagnostic is emitted.
    let commentCount = 0;
    if (!options.dryRun) {
        commentCount = insertDiagnosticComments(project, fileResults);
        project.saveSync();
    }

    return {
        filesChanged,
        totalChanges,
        diagnostics: allDiagnostics,
        fileResults,
        packageJsonChanges,
        commentCount
    };
}
