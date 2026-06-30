import { statSync } from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';
import type { Node } from 'ts-morph';
import { Project, SyntaxKind } from 'ts-morph';

import { MOCK_CALLERS, MOCK_METHODS } from './migrations/v1-to-v2/transforms/mockPaths';
import type { Diagnostic, FileResult, Migration, PackageJsonChange, RunnerOptions, RunnerResult } from './types';
import { CODEMOD_ERROR_PREFIX, error } from './utils/diagnostics';
import { isSdkSpecifier, isV2Specifier } from './utils/importUtils';
import { discoverManifests, ownerManifest, updatePackageJson } from './utils/packageJsonUpdater';
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

    // A file target scopes the run to that one source file; project context and the
    // nearest-manifest rule still derive from its directory.
    const targetIsFile = (() => {
        try {
            return statSync(options.targetDir).isFile();
        } catch {
            return false;
        }
    })();

    const targetBase = fg.convertPathToPattern(path.resolve(targetIsFile ? path.dirname(options.targetDir) : options.targetDir));
    const globPattern = `${targetBase}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`;
    // The positive pattern is absolute, so fast-glob compares ignore patterns against
    // absolute paths — a bare-relative --ignore would silently match nothing. Rebase
    // relative user patterns onto the target directory.
    const userIgnores = (options.ignore ?? []).map(pattern => {
        // User ignores are PATTERNS, not paths: convertPathToPattern would escape
        // their glob metacharacters (`**` → `\*\*`) and they would match nothing.
        // fast-glob needs forward slashes, so Windows separators are normalized.
        if (pattern.startsWith('**') || path.isAbsolute(pattern)) {
            return path.sep === '\\' ? pattern.replaceAll('\\', '/') : pattern;
        }
        return `${targetBase}/${pattern}`;
    });
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
        ...userIgnores
    ];

    // Collect files with fast-glob directly instead of ts-morph's glob handling:
    // symbolic links are never followed (pnpm node_modules layouts contain symlink
    // cycles that ELOOP a following walker) and ignore patterns — including the
    // user's --ignore — apply during directory descent, not as a post-filter.
    const files = targetIsFile
        ? [path.resolve(options.targetDir)]
        : fg.sync(globPattern, {
              ignore: ignorePatterns,
              followSymbolicLinks: false,
              suppressErrors: true,
              absolute: true
          });
    for (const filePath of files) {
        project.addSourceFileAtPathIfExists(filePath);
    }

    const sourceFiles = project.getSourceFiles().filter(sf => {
        const fp = sf.getFilePath();
        if (fp.includes('/node_modules/') || fp.includes('/dist/')) return false;
        if (fp.endsWith('.d.ts') || fp.endsWith('.d.mts') || fp.endsWith('.d.cts')) return false;
        return true;
    });
    const fileResults: FileResult[] = [];
    const allDiagnostics: Diagnostic[] = [];
    const shebangs = new Map<string, string>();
    let totalChanges = 0;
    let filesChanged = 0;

    for (const sourceFile of sourceFiles) {
        let fileChanges = 0;
        const fileDiagnostics: Diagnostic[] = [];
        const originalText = sourceFile.getFullText();

        // A leading `#!` shebang is leading trivia of the first import; some transforms drop it when
        // they rewrite that import, silently breaking CLI packages whose `bin` points at the compiled
        // entry. Capture it now and restore it after transforms, before saving. Include any blank lines
        // that followed it (also part of the same dropped trivia) so the original spacing round-trips —
        // the `\r?` keeps that working for CRLF files, where a blank line is `\r\n`.
        const shebangMatch = originalText.match(/^#![^\n]*\n(?:[ \t]*\r?\n)*/);
        if (shebangMatch) {
            shebangs.set(sourceFile.getFilePath(), shebangMatch[0]);
        }

        try {
            for (const transform of enabledTransforms) {
                const result = transform.apply(sourceFile, context);
                fileChanges += result.changesCount;
                fileDiagnostics.push(...result.diagnostics);
            }
        } catch (error_) {
            const filePath = sourceFile.getFilePath();
            fileDiagnostics.length = 0;
            fileDiagnostics.push(error(filePath, 1, `Transform failed: ${error_ instanceof Error ? error_.message : String(error_)}`));
            sourceFile.replaceWithText(originalText);
            fileChanges = 0;
        }

        // Heuristic advisories only flush for files a transform actually changed —
        // a re-run over a migrated tree stays quiet.
        if (fileChanges === 0) {
            const kept = fileDiagnostics.filter(d => !d.advisoryOnly);
            fileDiagnostics.length = 0;
            fileDiagnostics.push(...kept);
        }

        for (const d of fileDiagnostics) {
            if (d.resolveCurrentLine) {
                try {
                    d.line = d.resolveCurrentLine();
                } catch {
                    // The anchor node was removed by a later rewrite — the snapshot
                    // line is stale against the final text, so keep the console
                    // diagnostic but never insert a comment at the wrong place.
                    delete d.insertComment;
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

    // The v2 dependency set for each manifest is derived from the POST-transform
    // import state of the files it owns (longest-prefix match against the
    // discovered manifests). Reading the final state — rather than what this run
    // rewrote — means an already-migrated package whose v1 dependency is being
    // removed still gets the v2 packages its imports need.
    const hasImportsTransform = enabledTransforms.some(t => t.id === 'imports');
    let packageJsonChanges: PackageJsonChange[] | undefined;
    if (hasImportsTransform) {
        const manifests = discoverManifests(options.targetDir);
        const usedByManifest = new Map<string, Set<string>>();
        for (const sourceFile of sourceFiles) {
            const owner = ownerManifest(sourceFile.getFilePath(), manifests);
            if (!owner) continue;
            let used = usedByManifest.get(owner.path);
            if (!used) {
                used = new Set();
                usedByManifest.set(owner.path, used);
            }
            for (const decl of sourceFile.getImportDeclarations()) {
                const spec = decl.getModuleSpecifierValue();
                if (spec.startsWith('@modelcontextprotocol/')) used.add(spec);
            }
            for (const decl of sourceFile.getExportDeclarations()) {
                const spec = decl.getModuleSpecifierValue();
                if (spec !== undefined && spec.startsWith('@modelcontextprotocol/')) used.add(spec);
            }
            for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
                const exprText = call.getExpression().getText();
                const dot = exprText.indexOf('.');
                const isMockCall = dot !== -1 && MOCK_CALLERS.has(exprText.slice(0, dot)) && MOCK_METHODS.has(exprText.slice(dot + 1));
                const isModuleRef = call.getExpression().getKind() === SyntaxKind.ImportKeyword || exprText === 'require' || isMockCall;
                if (!isModuleRef) continue;
                const spec = call.getArguments()[0]?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
                if (spec !== undefined && spec.startsWith('@modelcontextprotocol/')) used.add(spec);
            }
        }
        // A single-file run sees one file's imports — applying a manifest edit from that
        // view could remove the v1 dependency the rest of the package still needs, so
        // manifests are report-only in file mode.
        const zodInjectedByManifest = new Map<string, string[]>();
        for (const fileResult of fileResults) {
            if (!fileResult.diagnostics.some(d => d.tag === 'zod-injected')) continue;
            const owner = ownerManifest(fileResult.filePath, manifests);
            if (!owner) continue;
            let files = zodInjectedByManifest.get(owner.path);
            if (!files) {
                files = [];
                zodInjectedByManifest.set(owner.path, files);
            }
            files.push(fileResult.filePath);
        }

        const changes = updatePackageJson(manifests, usedByManifest, (options.dryRun ?? false) || targetIsFile, zodInjectedByManifest);
        packageJsonChanges = changes.length > 0 ? changes : undefined;
    }

    const mcpImportFiles = sourceFiles.filter(sf =>
        sf.getImportDeclarations().some(decl => isV2Specifier(decl.getModuleSpecifierValue()))
    ).length;
    const v1ImportFiles = sourceFiles.filter(sf =>
        sf.getImportDeclarations().some(decl => isSdkSpecifier(decl.getModuleSpecifierValue()))
    ).length;

    // Per-file mutations are atomic: if any transform fails, the file is rolled back to its
    // original state and an error diagnostic is emitted.
    let commentCount = 0;
    if (!options.dryRun) {
        commentCount = insertDiagnosticComments(project, fileResults);
        // Restore any shebang a transform dropped. Done after comment insertion so the inserted
        // comments (positioned against the post-transform text) shift down with the code uniformly.
        for (const [filePath, shebang] of shebangs) {
            const sf = project.getSourceFile(filePath);
            if (sf && !sf.getFullText().startsWith('#!')) {
                sf.insertText(0, shebang);
                // Diagnostic lines were resolved against the post-transform, shebang-stripped text;
                // re-inserting the shebang pushes every line down by its line count, so bump the reported
                // lines to stay aligned with the saved file. (Comment insertion above already ran against
                // the stripped text, so its placement is unaffected.) These Diagnostic objects are shared
                // with the returned `diagnostics` array, so the fix reaches the CLI output and report too.
                const lineShift = (shebang.match(/\n/g) ?? []).length;
                const fileResult = fileResults.find(fr => fr.filePath === filePath);
                if (fileResult) {
                    for (const d of fileResult.diagnostics) d.line += lineShift;
                }
            }
        }
        project.saveSync();
    }

    return {
        filesChanged,
        totalChanges,
        diagnostics: allDiagnostics,
        fileResults,
        packageJsonChanges,
        mcpImportFiles,
        v1ImportFiles,
        commentCount
    };
}
