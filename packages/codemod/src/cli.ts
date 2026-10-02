#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Command } from 'commander';

import { listMigrations } from './migrations/index';
import { run } from './runner';
import type { PackageJsonChange } from './types';
import { DiagnosticLevel } from './types';
import { detectFormatter } from './utils/detectFormatter';
import { CODEMOD_ERROR_PREFIX, formatDiagnostic } from './utils/diagnostics';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const SOURCE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function quoteArg(arg: string): string {
    return /\s/.test(arg) ? `"${arg}"` : arg;
}

function hasManifestEdits(pc: PackageJsonChange): boolean {
    return pc.added.length > 0 || pc.removed.length > 0;
}

function printManifestChange(pc: PackageJsonChange): void {
    console.log(`  ${path.relative(process.cwd(), pc.packageJsonPath) || pc.packageJsonPath}`);
    if (pc.removed.length > 0) {
        console.log(`    Removed: ${pc.removed.join(', ')}`);
    }
    if (pc.added.length > 0) {
        console.log(`    Added:   ${pc.added.join(', ')}`);
    }
    for (const n of pc.notes ?? []) {
        console.log(`    Note: ${n}`);
    }
    for (const w of pc.warnings ?? []) {
        console.log(`    Warning: ${w}`);
    }
}

/**
 * The codemod transforms the AST but does not reformat — wrapped schemas and
 * generated string literals can violate a repo's lint/formatting rules. Point
 * the user at their own formatter (which respects their config) for the exact
 * files that changed.
 */
function printFormatGuidance(targetDir: string, changedFiles: string[]): void {
    if (changedFiles.length === 0) return;

    const formatter = detectFormatter(targetDir);
    const fileArgs = changedFiles.map(file => quoteArg(path.relative(process.cwd(), file) || file));

    console.log("This codemod doesn't reformat its output. Run your formatter on the changed file(s):");
    if (formatter) {
        console.log(`  ${formatter.bin} ${[...formatter.writeArgs, ...fileArgs].join(' ')}\n`);
    } else {
        console.log(`  e.g. prettier --write ${fileArgs.join(' ')}\n`);
    }
}

const program = new Command();

program.name('mcp-codemod').description('Codemod to migrate MCP TypeScript SDK code between versions').version(version);

for (const [name, migration] of listMigrations()) {
    program
        .command(`${name} [target-dir]`)
        .description(migration.description)
        .option('-d, --dry-run', 'Preview changes without writing files')
        .option('-t, --transforms <ids>', 'Comma-separated transform IDs to run (default: all)')
        .option('-v, --verbose', 'Show detailed per-change output')
        .option('--ignore <patterns...>', 'Additional glob patterns to ignore')
        .option('--list', 'List available transforms for this migration')
        .action((targetDir: string | undefined, opts: Record<string, unknown>) => {
            try {
                if (opts['list']) {
                    console.log(`\nAvailable transforms for ${name}:\n`);
                    for (const t of migration.transforms) {
                        console.log(`  ${t.id.padEnd(20)} ${t.name}`);
                    }
                    console.log('');
                    return;
                }

                if (!targetDir) {
                    console.error(`\nError: missing required argument <target-dir>.\n`);
                    process.exitCode = 1;
                    return;
                }

                const resolvedDir = path.resolve(targetDir);

                const targetExists = existsSync(resolvedDir);
                const targetIsFile = targetExists && statSync(resolvedDir).isFile();
                if (!targetExists || (!statSync(resolvedDir).isDirectory() && !(targetIsFile && SOURCE_FILE_RE.test(resolvedDir)))) {
                    console.error(`\nError: "${resolvedDir}" is not a directory or a TypeScript/JavaScript source file.\n`);
                    process.exitCode = 1;
                    return;
                }
                if (targetIsFile && /\.d\.(?:ts|mts|cts)$/.test(resolvedDir)) {
                    console.error(`\nError: "${resolvedDir}" is a declaration file — declaration files are not migration targets.\n`);
                    process.exitCode = 1;
                    return;
                }

                console.log(`\n@modelcontextprotocol/codemod — ${migration.name}\n`);
                console.log(`Scanning ${resolvedDir}...`);
                if (opts['dryRun']) {
                    console.log('(dry run — no files will be modified)\n');
                } else {
                    console.log('');
                }

                const transforms = opts['transforms'] ? (opts['transforms'] as string).split(',').map(s => s.trim()) : undefined;

                const result = run(migration, {
                    targetDir: resolvedDir,
                    dryRun: opts['dryRun'] as boolean | undefined,
                    verbose: opts['verbose'] as boolean | undefined,
                    transforms,
                    ignore: opts['ignore'] as string[] | undefined
                });

                if (result.filesChanged === 0 && result.diagnostics.length === 0 && !result.packageJsonChanges) {
                    if (result.mcpImportFiles > 0 && result.v1ImportFiles === 0) {
                        console.log(`No changes needed — ${result.mcpImportFiles} file(s) already import the v2 packages.\n`);
                    } else if (result.v1ImportFiles > 0) {
                        console.log(
                            `No changes applied — ${result.v1ImportFiles} file(s) still import the v1 SDK ` +
                                `(check which transforms were selected).\n`
                        );
                    } else {
                        console.log(`No MCP SDK imports found under ${resolvedDir} — nothing to migrate.\n`);
                    }
                    return;
                }

                if (targetIsFile && result.packageJsonChanges) {
                    console.log(
                        'Single-file run: manifest changes are reported for the owning package but not applied — ' +
                            'run the codemod at the package root to apply them.\n'
                    );
                }

                if (result.filesChanged > 0) {
                    console.log(`Changes: ${result.totalChanges} across ${result.filesChanged} file(s)\n`);
                }

                if (opts['verbose']) {
                    const modified = result.fileResults.filter(fr => fr.changes > 0);
                    const diagnosticsOnly = result.fileResults.filter(fr => fr.changes === 0 && fr.diagnostics.length > 0);
                    if (modified.length > 0) {
                        console.log('Files modified:');
                        for (const fr of modified) {
                            console.log(`  ${fr.filePath} (${fr.changes} change(s))`);
                        }
                    }
                    if (diagnosticsOnly.length > 0) {
                        console.log('Files with diagnostics only (not modified):');
                        for (const fr of diagnosticsOnly) {
                            console.log(`  ${fr.filePath} (${fr.diagnostics.length} diagnostic(s))`);
                        }
                    }
                    console.log('');
                }

                const errors = result.diagnostics.filter(d => d.level === DiagnosticLevel.Error);
                if (errors.length > 0) {
                    console.log(`Errors (${errors.length}):`);
                    for (const d of errors) {
                        console.log(formatDiagnostic(d));
                    }
                    console.log('');
                    process.exitCode = 1;
                }

                const warnings = result.diagnostics.filter(d => d.level === DiagnosticLevel.Warning && d.category !== 'v2-gap');
                if (warnings.length > 0) {
                    console.log(`Warnings (${warnings.length}):`);
                    for (const d of warnings) {
                        console.log(formatDiagnostic(d));
                    }
                    console.log('');
                }

                const infos = result.diagnostics.filter(d => d.level === DiagnosticLevel.Info);
                if (infos.length > 0) {
                    console.log(`Info (${infos.length}):`);
                    for (const d of infos) {
                        console.log(formatDiagnostic(d));
                    }
                    console.log('');
                }

                const v2Gaps = result.diagnostics.filter(d => d.category === 'v2-gap');
                if (v2Gaps.length > 0) {
                    console.log(`SDK v2 known issues (${v2Gaps.length}):`);
                    for (const d of v2Gaps) {
                        console.log(formatDiagnostic(d));
                    }
                    console.log('');
                }

                const manifestChanges = result.packageJsonChanges ?? [];
                // In single-file mode nothing is written, so even the nearest manifest's
                // change set is presented as a report.
                const appliedManifests = manifestChanges.filter(pc => pc.applied && hasManifestEdits(pc) && !targetIsFile);
                const reportedManifests = manifestChanges.filter(pc => (!pc.applied || targetIsFile) && hasManifestEdits(pc));
                const warningOnlyManifests = manifestChanges.filter(pc => !hasManifestEdits(pc));
                if (manifestChanges.length > 0) {
                    if (appliedManifests.length > 0) {
                        if (opts['dryRun']) {
                            console.log('package.json changes (dry run — not applied):');
                        } else {
                            console.log('package.json updated:');
                        }
                        for (const pc of appliedManifests) {
                            printManifestChange(pc);
                        }
                    }
                    if (reportedManifests.length > 0) {
                        console.log(
                            'Manifests that declare @modelcontextprotocol/sdk but are not modified by the codemod — apply the listed changes yourself:'
                        );
                        for (const pc of reportedManifests) {
                            printManifestChange(pc);
                        }
                    }
                    if (warningOnlyManifests.length > 0) {
                        console.log('Manifest warnings:');
                        for (const pc of warningOnlyManifests) {
                            printManifestChange(pc);
                        }
                    }
                    console.log('');
                }

                if (result.commentCount > 0) {
                    console.log(
                        `${result.commentCount} location(s) marked with ${CODEMOD_ERROR_PREFIX} comments — search your code to find them:\n` +
                            `  grep -r '${CODEMOD_ERROR_PREFIX}' "${resolvedDir}"\n`
                    );
                }

                if (opts['dryRun']) {
                    console.log('Run without --dry-run to apply changes.\n');
                } else {
                    const changedFiles = result.fileResults.filter(fr => fr.changes > 0).map(fr => fr.filePath);
                    printFormatGuidance(resolvedDir, changedFiles);
                    if (reportedManifests.length > 0) {
                        console.log(
                            'Apply the manifest changes listed above, then run your package manager to install the new packages.\n'
                        );
                    } else if (appliedManifests.length > 0) {
                        console.log('Run your package manager to install the new packages.\n');
                    }
                    console.log('Migration complete. Review the changes and run your build/tests.\n');
                }
            } catch (error) {
                console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
                process.exitCode = 1;
            }
        });
}

program.parse();
