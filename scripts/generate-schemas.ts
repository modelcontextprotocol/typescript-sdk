/**
 * Schema Generation Script using ts-to-zod as a library
 *
 * This script generates Zod schemas from spec.types.ts with pre-processing and
 * post-processing for SDK compatibility.
 *
 * ## Pipeline
 *
 * 1. **Pre-process spec.types.ts** - Transform type hierarchy to match SDK:
 *    - `extends JSONRPCRequest` → `extends Request`
 *    - `extends JSONRPCNotification` → `extends Notification`
 *
 * 2. **Generate schemas** via ts-to-zod library
 *
 * 3. **Post-process schemas** for Zod v4 compatibility:
 *    - `"zod"` → `"zod/v4"`
 *    - `z.record().and(z.object())` → `z.looseObject()`
 *    - `jsonrpc: z.any()` → `z.literal("2.0")`
 *    - Add `.int()` refinements to ProgressTokenSchema, RequestIdSchema
 *
 * ## Why Pre-Process Types?
 *
 * The MCP spec defines request/notification types extending JSONRPCRequest/JSONRPCNotification
 * which include `jsonrpc` and `id` fields. The SDK handles these at the transport layer,
 * so SDK types extend the simpler Request/Notification without these fields.
 *
 * By transforming the types BEFORE schema generation, we get schemas that match
 * the SDK's type hierarchy exactly, enabling types.ts to re-export from generated/.
 *
 * @see https://github.com/fabien0102/ts-to-zod
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'ts-to-zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const SPEC_TYPES_FILE = join(PROJECT_ROOT, 'src', 'spec.types.ts');
const GENERATED_DIR = join(PROJECT_ROOT, 'src', 'generated');
const SCHEMA_OUTPUT_FILE = join(GENERATED_DIR, 'spec.schemas.ts');
const SCHEMA_TEST_OUTPUT_FILE = join(GENERATED_DIR, 'spec.schemas.zod.test.ts');

// =============================================================================
// Pre-processing: Transform spec types to SDK-compatible hierarchy
// =============================================================================

/**
 * Pre-process spec.types.ts to transform type hierarchy for SDK compatibility.
 *
 * The MCP spec defines:
 * - `interface InitializeRequest extends JSONRPCRequest { ... }`
 * - `interface CancelledNotification extends JSONRPCNotification { ... }`
 *
 * JSONRPCRequest/JSONRPCNotification include `jsonrpc` and `id` fields.
 * The SDK handles these at the transport layer, so SDK types should extend
 * the simpler Request/Notification without these fields.
 *
 * This transformation allows the generated schemas to match types.ts exactly.
 *
 * ## Alternative: ts-morph for AST-based transforms
 *
 * If regex becomes fragile, consider using ts-morph for precise AST manipulation:
 * ```typescript
 * import { Project } from 'ts-morph';
 * const project = new Project();
 * const sourceFile = project.createSourceFile('temp.ts', content);
 * for (const iface of sourceFile.getInterfaces()) {
 *     for (const ext of iface.getExtends()) {
 *         if (ext.getText() === 'JSONRPCRequest') ext.replaceWithText('Request');
 *         if (ext.getText() === 'JSONRPCNotification') ext.replaceWithText('Notification');
 *     }
 * }
 * return sourceFile.getFullText();
 * ```
 */
function preProcessTypes(content: string): string {
    // Transform extends clauses for requests
    // e.g., "extends JSONRPCRequest" → "extends Request"
    content = content.replace(/\bextends\s+JSONRPCRequest\b/g, 'extends Request');

    // Transform extends clauses for notifications
    // e.g., "extends JSONRPCNotification" → "extends Notification"
    content = content.replace(/\bextends\s+JSONRPCNotification\b/g, 'extends Notification');

    return content;
}

async function main() {
    console.log('🔧 Generating Zod schemas from spec.types.ts...\n');

    // Ensure generated directory exists
    if (!existsSync(GENERATED_DIR)) {
        mkdirSync(GENERATED_DIR, { recursive: true });
    }

    // Read and pre-process spec types to match SDK hierarchy
    const rawSourceText = readFileSync(SPEC_TYPES_FILE, 'utf-8');
    const sourceText = preProcessTypes(rawSourceText);

    const result = generate({
        sourceText,
        keepComments: true,
        skipParseJSDoc: false,
        // Use PascalCase naming to match existing types.ts convention
        // e.g., ProgressToken → ProgressTokenSchema
        getSchemaName: (typeName: string) => `${typeName}Schema`,
    });

    if (result.errors.length > 0) {
        console.error('❌ Generation errors:');
        for (const error of result.errors) {
            console.error(`  - ${error}`);
        }
        process.exit(1);
    }

    if (result.hasCircularDependencies) {
        console.warn('⚠️  Warning: Circular dependencies detected in types');
    }

    // Generate schema file with relative import to spec.types
    let schemasContent = result.getZodSchemasFile('../spec.types.js');
    schemasContent = postProcess(schemasContent);

    writeFileSync(SCHEMA_OUTPUT_FILE, schemasContent, 'utf-8');
    console.log(`✅ Written: ${SCHEMA_OUTPUT_FILE}`);

    // Generate integration tests that verify schemas match TypeScript types
    const testsContent = result.getIntegrationTestFile(
        '../spec.types.js',
        './spec.schemas.js',
    );
    if (testsContent) {
        const processedTests = postProcessTests(testsContent);
        writeFileSync(SCHEMA_TEST_OUTPUT_FILE, processedTests, 'utf-8');
        console.log(`✅ Written: ${SCHEMA_TEST_OUTPUT_FILE}`);
    }

    console.log('\n🎉 Schema generation complete!');
}

/**
 * Post-process generated schemas for project compatibility.
 */
function postProcess(content: string): string {
    // 1. Update import to use zod/v4
    content = content.replace(
        'import { z } from "zod";',
        'import { z } from "zod/v4";',
    );

    // 2. Replace z.record().and(z.object({...})) with z.looseObject({...})
    // Uses brace-counting to handle nested objects correctly.
    content = replaceRecordAndWithLooseObject(content);

    // 3. Fix typeof expressions that became z.any()
    // ts-to-zod can't translate `typeof CONST` and falls back to z.any()
    content = fixTypeOfExpressions(content);

    // 4. Add integer refinements to match SDK types.ts
    content = addIntegerRefinements(content);

    // Note: SDK hierarchy remapping is now done as PRE-processing on the types,
    // not post-processing on the schemas. See preProcessTypes().

    // 5. Add header comment
    content = content.replace(
        '// Generated by ts-to-zod',
        `// Generated by ts-to-zod
// Post-processed for Zod v4 compatibility
// Run: npm run generate:schemas`,
    );

    return content;
}

/**
 * Fix typeof expressions that ts-to-zod couldn't translate.
 *
 * In the spec, these patterns use `typeof CONST`:
 * - `jsonrpc: typeof JSONRPC_VERSION` where JSONRPC_VERSION = "2.0"
 * - `code: typeof URL_ELICITATION_REQUIRED` where URL_ELICITATION_REQUIRED = -32042
 *
 * ts-to-zod generates `z.any()` for these, which we replace with proper literals.
 */
function fixTypeOfExpressions(content: string): string {
    // Fix jsonrpc: z.any() → jsonrpc: z.literal("2.0")
    // This appears in JSONRPCRequest, JSONRPCNotification, JSONRPCResponse schemas
    content = content.replace(
        /jsonrpc: z\.any\(\)/g,
        'jsonrpc: z.literal("2.0")'
    );

    // Note: URL_ELICITATION_REQUIRED code field is inside a more complex structure
    // and may need specific handling if tests fail

    return content;
}

/**
 * Add integer refinements to numeric schemas.
 *
 * The SDK uses .int() for:
 * - ProgressToken (numeric tokens should be integers)
 * - RequestId (numeric IDs should be integers)
 *
 * This matches the manual types.ts behavior.
 */
function addIntegerRefinements(content: string): string {
    // ProgressTokenSchema: z.union([z.string(), z.number()]) → z.union([z.string(), z.number().int()])
    content = content.replace(
        /export const ProgressTokenSchema = z\.union\(\[z\.string\(\), z\.number\(\)\]\)/,
        'export const ProgressTokenSchema = z.union([z.string(), z.number().int()])'
    );

    // RequestIdSchema: z.union([z.string(), z.number()]) → z.union([z.string(), z.number().int()])
    content = content.replace(
        /export const RequestIdSchema = z\.union\(\[z\.string\(\), z\.number\(\)\]\)/,
        'export const RequestIdSchema = z.union([z.string(), z.number().int()])'
    );

    return content;
}

/**
 * Replace z.record(z.string(), z.unknown()).and(z.object({...})) with z.looseObject({...})
 * Uses brace-counting to handle nested objects correctly.
 */
function replaceRecordAndWithLooseObject(content: string): string {
    const pattern = 'z.record(z.string(), z.unknown()).and(z.object({';
    let result = content;
    let startIndex = 0;

    while (true) {
        const matchStart = result.indexOf(pattern, startIndex);
        if (matchStart === -1) break;

        // Find the matching closing brace for z.object({
        const objectStart = matchStart + pattern.length;
        let braceCount = 1;
        let i = objectStart;

        while (i < result.length && braceCount > 0) {
            if (result[i] === '{') braceCount++;
            else if (result[i] === '}') braceCount--;
            i++;
        }

        // i now points after the closing } of z.object({...})
        // Check if followed by ))
        if (result.slice(i, i + 2) === '))') {
            const objectContent = result.slice(objectStart, i - 1);
            const replacement = `z.looseObject({${objectContent}})`;
            result = result.slice(0, matchStart) + replacement + result.slice(i + 2);
            startIndex = matchStart + replacement.length;
        } else {
            startIndex = i;
        }
    }

    return result;
}

/**
 * Post-process generated integration tests.
 */
function postProcessTests(content: string): string {
    content = content.replace(
        'import { z } from "zod";',
        'import { z } from "zod/v4";',
    );

    content = content.replace(
        '// Generated by ts-to-zod',
        `// Generated by ts-to-zod
// Integration tests verifying schemas match TypeScript types
// Run: npm run generate:schemas`,
    );

    return content;
}

main().catch((error) => {
    console.error('❌ Schema generation failed:', error);
    process.exit(1);
});
