#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Command } from 'commander';

import { listMigrations } from './migrations/index.js';
import { run } from './runner.js';
import { DiagnosticLevel } from './types.js';
import { formatDiagnostic } from './utils/diagnostics.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program.name('mcp-codemod').description('Codemod to migrate MCP TypeScript SDK code between versions').version(version);

for (const [name, migration] of listMigrations()) {
    program
        .command(`${name} <target-dir>`)
        .description(migration.description)
        .option('-d, --dry-run', 'Preview changes without writing files')
        .option('-t, --transforms <ids>', 'Comma-separated transform IDs to run (default: all)')
        .option('-v, --verbose', 'Show detailed per-change output')
        .option('--ignore <patterns...>', 'Additional glob patterns to ignore')
        .option('--list', 'List available transforms for this migration')
        .action((targetDir: string, opts: Record<string, unknown>) => {
            try {
                if (opts['list']) {
                    console.log(`\nAvailable transforms for ${name}:\n`);
                    for (const t of migration.transforms) {
                        console.log(`  ${t.id.padEnd(20)} ${t.name}`);
                    }
                    console.log('');
                    return;
                }

                const resolvedDir = path.resolve(targetDir);

                if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
                    console.error(`\nError: "${resolvedDir}" is not a valid directory.\n`);
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

                if (result.filesChanged === 0 && result.diagnostics.length === 0) {
                    console.log('No changes needed — code already migrated or no SDK imports found.\n');
                    return;
                }

                if (result.filesChanged > 0) {
                    console.log(`Changes: ${result.totalChanges} across ${result.filesChanged} file(s)\n`);
                }

                if (opts['verbose']) {
                    console.log('Files modified:');
                    for (const fr of result.fileResults) {
                        console.log(`  ${fr.filePath} (${fr.changes} change(s))`);
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

                const warnings = result.diagnostics.filter(d => d.level === DiagnosticLevel.Warning);
                if (warnings.length > 0) {
                    console.log(`Warnings (${warnings.length}):`);
                    for (const d of warnings) {
                        console.log(formatDiagnostic(d));
                    }
                    console.log('');
                    process.exitCode = 1;
                }

                if (opts['dryRun']) {
                    console.log('Run without --dry-run to apply changes.\n');
                } else {
                    console.log('Migration complete. Review the changes and run your build/tests.\n');
                }
            } catch (error) {
                console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
                process.exitCode = 1;
            }
        });
}

program.parse();
