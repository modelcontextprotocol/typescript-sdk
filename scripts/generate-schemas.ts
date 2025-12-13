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
 * 3. **Post-process schemas** using ts-morph AST transforms:
 *    - `"zod"` → `"zod/v4"`
 *    - `z.record().and(z.object())` → `z.looseObject()`
 *    - `jsonrpc: z.any()` → `z.literal("2.0")`
 *    - Add `.int()` refinements to ProgressTokenSchema, RequestIdSchema
 *    - `z.union([z.literal("a"), ...])` → `z.enum(["a", ...])`
 *    - Field-level validation overrides (datetime, startsWith, etc.)
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
 * @see https://github.com/dsherret/ts-morph
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'ts-to-zod';
import { Project, SyntaxKind, Node, CallExpression, PropertyAssignment } from 'ts-morph';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const SPEC_TYPES_FILE = join(PROJECT_ROOT, 'src', 'spec.types.ts');
const SDK_TYPES_FILE = join(PROJECT_ROOT, 'src', 'generated', 'sdk.types.ts');
const GENERATED_DIR = join(PROJECT_ROOT, 'src', 'generated');
const SCHEMA_OUTPUT_FILE = join(GENERATED_DIR, 'sdk.schemas.ts');
const SCHEMA_TEST_OUTPUT_FILE = join(GENERATED_DIR, 'sdk.schemas.zod.test.ts');

// =============================================================================
// Configuration: Field-level validation overrides
// =============================================================================

/**
 * Base64 validation expression - validates that a string is valid base64.
 * Used for image data, audio data, and blob contents.
 */
const BASE64_VALIDATOR = `z.string().refine(
    (val) => { try { atob(val); return true; } catch { return false; } },
    { message: 'Invalid base64 string' }
)`;

/**
 * Field-level overrides for enhanced validation.
 * These replace generated z.string() with more specific validators.
 */
const FIELD_OVERRIDES: Record<string, Record<string, string>> = {
    'AnnotationsSchema': {
        'lastModified': 'z.iso.datetime({ offset: true }).optional()'
    },
    'RootSchema': {
        'uri': 'z.string().startsWith("file://")'
    },
    // Base64 validation for binary content
    'ImageContentSchema': {
        'data': BASE64_VALIDATOR
    },
    'AudioContentSchema': {
        'data': BASE64_VALIDATOR
    },
    'BlobResourceContentsSchema': {
        'blob': BASE64_VALIDATOR
    }
};

/**
 * Schemas that need .int() added to their z.number() members.
 */
const INTEGER_SCHEMAS = ['ProgressTokenSchema', 'RequestIdSchema'];

// =============================================================================
// Pre-processing: Transform spec types to SDK-compatible hierarchy
// =============================================================================

/**
 * The SDK-specific meta key for relating messages to tasks.
 * This is added to RequestParams._meta during pre-processing.
 */
const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/**
 * Pre-process spec.types.ts using ts-morph to transform for SDK compatibility.
 *
 * Transforms:
 * 1. `extends JSONRPCRequest` → `extends Request`
 * 2. `extends JSONRPCNotification` → `extends Notification`
 * 3. Add RELATED_TASK_META_KEY to RequestParams._meta
 * 4. Change Request.params type to use RequestParams (for proper _meta typing)
 */
function preProcessTypes(content: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('types.ts', content);

    console.log('  🔧 Pre-processing types...');

    // Transform 1 & 2: Change extends clauses
    transformExtendsClause(sourceFile, 'JSONRPCRequest', 'Request');
    transformExtendsClause(sourceFile, 'JSONRPCNotification', 'Notification');

    // Transform 3: Add RELATED_TASK_META_KEY to RequestParams._meta
    injectRelatedTaskMetaKey(sourceFile);

    // Transform 4: Update Request.params to use RequestParams
    updateRequestParamsType(sourceFile);

    return sourceFile.getFullText();
}

/**
 * Transform extends clauses from one type to another.
 */
function transformExtendsClause(sourceFile: SourceFile, from: string, to: string): void {
    for (const iface of sourceFile.getInterfaces()) {
        for (const ext of iface.getExtends()) {
            if (ext.getText() === from) {
                ext.replaceWithText(to);
                console.log(`    - ${iface.getName()}: extends ${from} → extends ${to}`);
            }
        }
    }
}

/**
 * Inject RELATED_TASK_META_KEY into RequestParams._meta interface.
 *
 * Before:
 *   _meta?: {
 *     progressToken?: ProgressToken;
 *     [key: string]: unknown;
 *   };
 *
 * After:
 *   _meta?: {
 *     progressToken?: ProgressToken;
 *     'io.modelcontextprotocol/related-task'?: RelatedTaskMetadata;
 *     [key: string]: unknown;
 *   };
 */
function injectRelatedTaskMetaKey(sourceFile: SourceFile): void {
    const requestParams = sourceFile.getInterface('RequestParams');
    if (!requestParams) {
        console.warn('    ⚠️  RequestParams interface not found');
        return;
    }

    const metaProp = requestParams.getProperty('_meta');
    if (!metaProp) {
        console.warn('    ⚠️  _meta property not found in RequestParams');
        return;
    }

    // Get the type of _meta (it's an inline type literal)
    const typeNode = metaProp.getTypeNode();
    if (!typeNode || !Node.isTypeLiteral(typeNode)) {
        console.warn('    ⚠️  _meta is not a type literal');
        return;
    }

    // Check if already has the key
    const existingMember = typeNode.getMembers().find(m => {
        if (Node.isPropertySignature(m)) {
            const name = m.getName();
            return name === `'${RELATED_TASK_META_KEY}'` || name === `"${RELATED_TASK_META_KEY}"`;
        }
        return false;
    });

    if (existingMember) {
        console.log('    - RequestParams._meta already has RELATED_TASK_META_KEY');
        return;
    }

    // Find the index signature ([key: string]: unknown) to insert before it
    const members = typeNode.getMembers();
    const indexSignatureIndex = members.findIndex(m => Node.isIndexSignatureDeclaration(m));

    // Create the new property
    const newProperty = `/**
     * If specified, this request is related to the provided task.
     */
    '${RELATED_TASK_META_KEY}'?: RelatedTaskMetadata;`;

    if (indexSignatureIndex >= 0) {
        // Insert before index signature
        typeNode.insertMember(indexSignatureIndex, newProperty);
    } else {
        // Add at the end
        typeNode.addMember(newProperty);
    }

    console.log('    ✓ Injected RELATED_TASK_META_KEY into RequestParams._meta');
}

/**
 * Update Request.params and Notification.params to use proper param types.
 *
 * Before:
 *   interface Request { params?: { [key: string]: any }; }
 *   interface Notification { params?: { [key: string]: any }; }
 *
 * After:
 *   interface Request { params?: RequestParams & { [key: string]: any }; }
 *   interface Notification { params?: NotificationParams & { [key: string]: any }; }
 */
function updateRequestParamsType(sourceFile: SourceFile): void {
    // Update Request.params
    const requestInterface = sourceFile.getInterface('Request');
    if (requestInterface) {
        const paramsProp = requestInterface.getProperty('params');
        if (paramsProp) {
            paramsProp.setType('RequestParams & { [key: string]: any }');
            console.log('    ✓ Updated Request.params to include RequestParams');
        }
    }

    // Update Notification.params
    const notificationInterface = sourceFile.getInterface('Notification');
    if (notificationInterface) {
        const paramsProp = notificationInterface.getProperty('params');
        if (paramsProp) {
            paramsProp.setType('NotificationParams & { [key: string]: any }');
            console.log('    ✓ Updated Notification.params to include NotificationParams');
        }
    }
}

// =============================================================================
// Post-processing: AST-based transforms using ts-morph
// =============================================================================

type SourceFile = ReturnType<Project['createSourceFile']>;
type Transform = (sourceFile: SourceFile) => void;

/**
 * AST transforms applied in order. Functions are named for logging.
 */
const AST_TRANSFORMS: Transform[] = [
    transformRecordAndToLooseObject,
    transformTypeofExpressions,
    transformIntegerRefinements,
    transformUnionToEnum,
    applyFieldOverrides,
];

/**
 * Post-process generated schemas using ts-morph for robust AST manipulation.
 */
function postProcess(content: string): string {
    // Quick text-based transforms first (simpler cases)
    content = content.replace(
        'import { z } from "zod";',
        'import { z } from "zod/v4";',
    );

    content = content.replace(
        '// Generated by ts-to-zod',
        `// Generated by ts-to-zod
// Post-processed for Zod v4 compatibility
// Run: npm run generate:schemas`,
    );

    // AST-based transforms using ts-morph
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('schemas.ts', content);

    console.log('  🔧 Applying AST transforms...');
    for (const transform of AST_TRANSFORMS) {
        console.log(`    - ${transform.name}`);
        transform(sourceFile);
    }

    return sourceFile.getFullText();
}

/**
 * Transform z.record(z.string(), z.unknown()).and(z.object({...})) to z.looseObject({...})
 */
function transformRecordAndToLooseObject(sourceFile: SourceFile): void {
    // Find all call expressions
    sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;

        const text = node.getText();
        // Match pattern: z.record(...).and(z.object({...}))
        if (!text.startsWith('z.record(z.string(), z.unknown()).and(z.object(')) return;

        // Extract the object contents from z.object({...})
        const andCall = node;
        const args = andCall.getArguments();
        if (args.length !== 1) return;

        const objectCall = args[0];
        if (!Node.isCallExpression(objectCall)) return;

        const objectArgs = objectCall.getArguments();
        if (objectArgs.length !== 1) return;

        const objectLiteral = objectArgs[0];
        if (!Node.isObjectLiteralExpression(objectLiteral)) return;

        // Replace with z.looseObject({...})
        const objectContent = objectLiteral.getText();
        node.replaceWithText(`z.looseObject(${objectContent})`);
    });
}

/**
 * Transform typeof expressions that became z.any() into proper literals.
 */
function transformTypeofExpressions(sourceFile: SourceFile): void {
    // Find property assignments with jsonrpc: z.any()
    sourceFile.forEachDescendant((node) => {
        if (!Node.isPropertyAssignment(node)) return;

        const name = node.getName();
        const initializer = node.getInitializer();
        if (!initializer) return;

        const initText = initializer.getText();

        if (name === 'jsonrpc' && initText === 'z.any()') {
            node.setInitializer('z.literal("2.0")');
        }
    });
}

/**
 * Add .int() refinement to z.number() in specific schemas.
 */
function transformIntegerRefinements(sourceFile: SourceFile): void {
    for (const schemaName of INTEGER_SCHEMAS) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) continue;

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        // Collect nodes first to avoid modifying while iterating
        const nodesToReplace: CallExpression[] = [];
        initializer.forEachDescendant((node) => {
            if (Node.isCallExpression(node) && node.getText() === 'z.number()') {
                nodesToReplace.push(node);
            }
        });

        // Replace in reverse order to maintain positions
        for (const node of nodesToReplace.reverse()) {
            node.replaceWithText('z.number().int()');
        }
    }
}

/**
 * Transform z.union([z.literal('a'), z.literal('b'), ...]) to z.enum(['a', 'b', ...])
 *
 * This handles cases that the regex approach missed, including chained methods.
 */
function transformUnionToEnum(sourceFile: SourceFile): void {
    // Collect union nodes that should be converted
    const nodesToReplace: Array<{ node: CallExpression; values: string[] }> = [];

    sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;

        // Check if this is z.union(...)
        const expr = node.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) return;
        if (expr.getName() !== 'union') return;

        const args = node.getArguments();
        if (args.length !== 1) return;

        const arrayArg = args[0];
        if (!Node.isArrayLiteralExpression(arrayArg)) return;

        // Check if ALL elements are z.literal('string')
        const elements = arrayArg.getElements();
        if (elements.length < 2) return;

        const literalValues: string[] = [];
        let allStringLiterals = true;

        for (const element of elements) {
            if (!Node.isCallExpression(element)) {
                allStringLiterals = false;
                break;
            }

            const elemExpr = element.getExpression();
            if (!Node.isPropertyAccessExpression(elemExpr)) {
                allStringLiterals = false;
                break;
            }

            if (elemExpr.getName() !== 'literal') {
                allStringLiterals = false;
                break;
            }

            const elemArgs = element.getArguments();
            if (elemArgs.length !== 1) {
                allStringLiterals = false;
                break;
            }

            const literalArg = elemArgs[0];
            if (!Node.isStringLiteral(literalArg)) {
                allStringLiterals = false;
                break;
            }

            literalValues.push(literalArg.getLiteralValue());
        }

        if (allStringLiterals && literalValues.length >= 2) {
            nodesToReplace.push({ node, values: literalValues });
        }
    });

    // Replace in reverse order
    for (const { node, values } of nodesToReplace.reverse()) {
        const enumValues = values.map(v => `'${v}'`).join(', ');
        node.replaceWithText(`z.enum([${enumValues}])`);
    }
}

/**
 * Apply field-level validation overrides to specific schemas.
 */
function applyFieldOverrides(sourceFile: SourceFile): void {
    for (const [schemaName, fields] of Object.entries(FIELD_OVERRIDES)) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) {
            console.warn(`    ⚠️  Schema not found for override: ${schemaName}`);
            continue;
        }

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        // Find property assignments matching the field names
        initializer.forEachDescendant((node) => {
            if (!Node.isPropertyAssignment(node)) return;

            const propName = node.getName();
            if (fields[propName]) {
                console.log(`    ✓ Override: ${schemaName}.${propName}`);
                node.setInitializer(fields[propName]);
            }
        });
    }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    console.log('🔧 Generating Zod schemas from spec.types.ts...\n');

    // Ensure generated directory exists
    if (!existsSync(GENERATED_DIR)) {
        mkdirSync(GENERATED_DIR, { recursive: true });
    }

    // Read and pre-process spec types to match SDK hierarchy
    const rawSourceText = readFileSync(SPEC_TYPES_FILE, 'utf-8');
    const sdkTypesContent = preProcessTypes(rawSourceText);

    // Write pre-processed types to sdk.types.ts
    const sdkTypesWithHeader = `/**
 * SDK-compatible types generated from spec.types.ts
 *
 * This file is auto-generated by scripts/generate-schemas.ts
 * DO NOT EDIT MANUALLY
 *
 * Transformations applied:
 * - \`extends JSONRPCRequest\` → \`extends Request\`
 * - \`extends JSONRPCNotification\` → \`extends Notification\`
 *
 * This allows SDK types to omit jsonrpc/id fields, which are
 * handled at the transport layer.
 */
${sdkTypesContent.replace(/^\/\*\*[\s\S]*?\*\/\n/, '')}`;
    writeFileSync(SDK_TYPES_FILE, sdkTypesWithHeader, 'utf-8');
    console.log(`✅ Written: ${SDK_TYPES_FILE}`);

    const result = generate({
        sourceText: sdkTypesContent,
        keepComments: true,
        skipParseJSDoc: false,
        // Use PascalCase naming to match existing types.ts convention
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

    // Generate schema file with relative import to sdk.types
    let schemasContent = result.getZodSchemasFile('./sdk.types.js');
    schemasContent = postProcess(schemasContent);

    writeFileSync(SCHEMA_OUTPUT_FILE, schemasContent, 'utf-8');
    console.log(`✅ Written: ${SCHEMA_OUTPUT_FILE}`);

    // Generate integration tests that verify schemas match TypeScript types
    const testsContent = result.getIntegrationTestFile(
        './sdk.types.js',
        './sdk.schemas.js',
    );
    if (testsContent) {
        const processedTests = postProcessTests(testsContent);
        writeFileSync(SCHEMA_TEST_OUTPUT_FILE, processedTests, 'utf-8');
        console.log(`✅ Written: ${SCHEMA_TEST_OUTPUT_FILE}`);
    }

    console.log('\n🎉 Schema generation complete!');
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
