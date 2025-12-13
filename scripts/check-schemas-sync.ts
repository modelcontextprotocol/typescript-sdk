#!/usr/bin/env npx tsx
/**
 * Checks if generated schemas are in sync with source types.
 * Exits with code 1 if regeneration would produce different output.
 *
 * Usage:
 *   npx tsx scripts/check-schemas-sync.ts
 *   npm run check:schemas
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const GENERATED_FILES = ['src/generated/sdk.types.ts', 'src/generated/sdk.schemas.ts'];

function main(): void {
    const rootDir = join(import.meta.dirname, '..');

    // Capture current content of generated files
    const originalContents = new Map<string, string>();
    for (const file of GENERATED_FILES) {
        const filePath = join(rootDir, file);
        try {
            originalContents.set(file, readFileSync(filePath, 'utf-8'));
        } catch {
            console.error(`Error: Generated file ${file} does not exist.`);
            console.error("Run 'npm run generate:schemas' to generate it.");
            process.exit(1);
        }
    }

    // Regenerate schemas
    console.log('Regenerating schemas to check for drift...');
    try {
        execSync('npm run generate:schemas', {
            cwd: rootDir,
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
        const filePath = join(rootDir, file);
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
        console.error("Run 'npm run generate:schemas' and commit the changes.");
        console.error('='.repeat(60));
        process.exit(1);
    }

    console.log('\n✓ All generated schemas are in sync.');
}

main();
