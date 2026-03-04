#!/usr/bin/env tsx
/**
 * Checks if generated schemas are in sync with source types.
 * Exits with code 1 if regeneration would produce different output.
 *
 * Usage:
 *   tsx scripts/check-schemas-sync.ts
 *   pnpm check:schemas
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const GENERATED_FILES = [
    'packages/core/src/types/generated/sdk.types.ts',
    'packages/core/src/types/generated/sdk.schemas.ts',
    'packages/core/src/types/generated/sdk.schemas.zod.test.ts'
];

function main(): void {
    // Capture current content of generated files
    const originalContents = new Map<string, string>();
    for (const file of GENERATED_FILES) {
        const filePath = join(PROJECT_ROOT, file);
        try {
            originalContents.set(file, readFileSync(filePath, 'utf-8'));
        } catch {
            console.error(`Error: Generated file ${file} does not exist.`);
            console.error("Run 'pnpm generate:schemas' to generate it.");
            process.exit(1);
        }
    }

    // Regenerate schemas
    console.log('Regenerating schemas to check for drift...');
    try {
        execSync('pnpm generate:schemas', {
            cwd: PROJECT_ROOT,
            stdio: 'pipe'
        });
    } catch (error) {
        console.error('Error: Schema generation failed.');
        console.error((error as Error).message);
        process.exit(1);
    }

    // Compare with original content
    let hasDrift = false;
    for (const file of GENERATED_FILES) {
        const filePath = join(PROJECT_ROOT, file);
        const newContent = readFileSync(filePath, 'utf-8');
        const originalContent = originalContents.get(file)!;

        if (newContent !== originalContent) {
            console.error(`\n❌ ${file} is out of sync with source types.`);
            hasDrift = true;
        } else {
            console.log(`✓ ${file} is up to date.`);
        }
    }

    if (hasDrift) {
        console.error('\n' + '='.repeat(60));
        console.error('Generated schemas are out of sync!');
        console.error("Run 'pnpm generate:schemas' and commit the changes.");
        console.error('='.repeat(60));
        process.exit(1);
    }

    console.log('\n✓ All generated schemas are in sync.');
}

main();
