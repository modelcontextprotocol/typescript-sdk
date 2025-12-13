/**
 * Schema Generation Script
 *
 * Generates Zod schemas from spec.types.ts using ts-to-zod, with declarative
 * transform pipelines for SDK compatibility.
 *
 * ## Pipeline
 *
 * ### Phase 1: Type Transforms (TYPE_TRANSFORMS)
 * Transform spec.types.ts → sdk.types.ts for SDK conventions:
 * - `extends JSONRPCRequest` → `extends Request`
 * - `extends JSONRPCNotification` → `extends Notification`
 * - Inject SDK-specific extensions (meta keys, capability types)
 * - Convert JSDoc to @description for .describe() generation
 *
 * ### Phase 2: Type Cleanup (TYPE_CLEANUP_TRANSFORMS)
 * Prepare types for clean SDK export:
 * - Remove index signatures (enables TypeScript union narrowing)
 * - Create union types (McpRequest, McpNotification, McpResult)
 *
 * ### Phase 3: Schema Transforms (SchemaTransforms)
 * Transform ts-to-zod output for Zod v4 and SDK conventions:
 * - Convert to Zod v4 imports and patterns
 * - Add field-level validation (datetime, base64, etc.)
 * - Add .strict(), .passthrough(), .default() as needed
 * - Convert to discriminatedUnion for better performance
 *
 * ## Architecture
 *
 * Each transform is a named function operating on a ts-morph SourceFile.
 * Transform arrays provide a declarative, reorderable pipeline.
 *
 * @see https://github.com/fabien0102/ts-to-zod
 * @see https://github.com/dsherret/ts-morph
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'ts-to-zod';
import {
    Project,
    SyntaxKind,
    Node,
    CallExpression,
    PropertyAssignment,
    SourceFile,
    InterfaceDeclaration,
    TypeAliasDeclaration
} from 'ts-morph';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const SPEC_TYPES_FILE = join(PROJECT_ROOT, 'src', 'spec.types.ts');
const SDK_TYPES_FILE = join(PROJECT_ROOT, 'src', 'generated', 'sdk.types.ts');
const GENERATED_DIR = join(PROJECT_ROOT, 'src', 'generated');
const SCHEMA_OUTPUT_FILE = join(GENERATED_DIR, 'sdk.schemas.ts');
const SCHEMA_TEST_OUTPUT_FILE = join(GENERATED_DIR, 'sdk.schemas.zod.test.ts');
const GENERATE_SCRIPT_FILE = join(PROJECT_ROOT, 'scripts', 'generate-schemas.ts');

// Input files that trigger regeneration
const INPUT_FILES = [SPEC_TYPES_FILE, GENERATE_SCRIPT_FILE];
// Output files that are generated
const OUTPUT_FILES = [SDK_TYPES_FILE, SCHEMA_OUTPUT_FILE, SCHEMA_TEST_OUTPUT_FILE];

/**
 * Check if any input file is newer than any output file.
 * Returns true if regeneration is needed.
 */
function needsRegeneration(): boolean {
    // Get the newest input mtime
    let newestInput = 0;
    for (const file of INPUT_FILES) {
        if (!existsSync(file)) {
            console.log(`  Input file missing: ${file}`);
            return true;
        }
        const mtime = statSync(file).mtimeMs;
        if (mtime > newestInput) newestInput = mtime;
    }

    // Get the oldest output mtime
    let oldestOutput = Infinity;
    for (const file of OUTPUT_FILES) {
        if (!existsSync(file)) {
            console.log(`  Output file missing: ${file}`);
            return true;
        }
        const mtime = statSync(file).mtimeMs;
        if (mtime < oldestOutput) oldestOutput = mtime;
    }

    return newestInput > oldestOutput;
}

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
    AnnotationsSchema: {
        lastModified: 'z.iso.datetime({ offset: true }).optional()'
    },
    RootSchema: {
        uri: 'z.string().startsWith("file://")'
    },
    // Base64 validation for binary content
    ImageContentSchema: {
        data: BASE64_VALIDATOR
    },
    AudioContentSchema: {
        data: BASE64_VALIDATOR
    },
    BlobResourceContentsSchema: {
        blob: BASE64_VALIDATOR
    }
};

/**
 * Schemas that need .int() added to their z.number() members.
 */
const INTEGER_SCHEMAS = ['ProgressTokenSchema', 'RequestIdSchema'];

/**
 * Fields that need .default([]) for backwards compatibility.
 * The SDK historically made these optional with empty array defaults.
 */
const ARRAY_DEFAULT_FIELDS: Record<string, string[]> = {
    CallToolResultSchema: ['content'],
    ToolResultContentSchema: ['content']
};

/**
 * Union member ordering: ensure specific schemas match before general ones.
 * More specific schemas (with more required fields) must come first in unions,
 * otherwise Zod will match a simpler schema and strip extra fields.
 *
 * Example: { type: 'string', enum: [...], enumNames: [...] } should match
 * LegacyTitledEnumSchema (which has enumNames) before UntitledSingleSelectEnumSchema.
 */
const UNION_MEMBER_ORDER: Record<string, string[]> = {
    // EnumSchema must come before StringSchema (both have type: 'string')
    PrimitiveSchemaDefinitionSchema: ['EnumSchemaSchema', 'BooleanSchemaSchema', 'StringSchemaSchema', 'NumberSchemaSchema'],
    // LegacyTitledEnumSchema must come first (has enumNames field)
    EnumSchemaSchema: ['LegacyTitledEnumSchemaSchema', 'SingleSelectEnumSchemaSchema', 'MultiSelectEnumSchemaSchema']
};

/**
 * Schemas that need .strict() added for stricter validation.
 */
const STRICT_SCHEMAS = [
    'JSONRPCRequestSchema',
    'JSONRPCNotificationSchema',
    'JSONRPCResultResponseSchema',
    'JSONRPCErrorResponseSchema',
    'EmptyResultSchema'
];

/**
 * Schemas that should use z.discriminatedUnion instead of z.union for better performance.
 * Maps schema name to the discriminator field name.
 */
const DISCRIMINATED_UNIONS: Record<string, string> = {
    SamplingContentSchema: 'type',
    SamplingMessageContentBlockSchema: 'type',
    ContentBlockSchema: 'type'
};

/**
 * Derived capability types to add during pre-processing.
 * These are extracted from parent capability interfaces for convenience.
 * Format: { typeName: { parent: 'ParentInterface', property: 'propertyName' } }
 */
const DERIVED_CAPABILITY_TYPES: Record<string, { parent: string; property: string }> = {
    ClientTasksCapability: { parent: 'ClientCapabilities', property: 'tasks' },
    ServerTasksCapability: { parent: 'ServerCapabilities', property: 'tasks' }
    // Note: ElicitationCapability is kept local in types.ts because it has z.preprocess for backwards compat
};

// =============================================================================
// Transform Infrastructure
// =============================================================================

/** A transform function that operates on a ts-morph SourceFile */
type Transform = (sourceFile: SourceFile) => void;


/**
 * Apply a list of transforms to content, logging each step.
 */
function applyTransforms(content: string, transforms: Transform[], label: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('source.ts', content);

    console.log(`  🔧 ${label}...`);
    for (const transform of transforms) {
        console.log(`    - ${transform.name}`);
        transform(sourceFile);
    }

    return sourceFile.getFullText();
}

// =============================================================================
// Type Transforms (spec.types.ts → sdk.types.ts)
// =============================================================================

/**
 * The SDK-specific meta key for relating messages to tasks.
 * This is added to RequestParams._meta during pre-processing.
 */
const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/**
 * Abstract base types excluded from union discovery.
 */
const UNION_EXCLUSIONS = new Set([
    'JSONRPCRequest',
    'JSONRPCNotification',
    'PaginatedRequest',
    'PaginatedResult'
]);

// =============================================================================
// Type Transforms (spec.types.ts → sdk.types.ts)
// =============================================================================

/**
 * Type transforms applied to spec.types.ts before schema generation.
 * These adapt the MCP spec types to SDK conventions.
 * Order matters: transforms are applied in property definition order.
 */
const TypeTransforms = {
    /** Transform `extends JSONRPCRequest` → `extends Request` */
    extendsJSONRPCRequest(sourceFile: SourceFile) {
        for (const iface of sourceFile.getInterfaces()) {
            for (const ext of iface.getExtends()) {
                if (ext.getText() === 'JSONRPCRequest') {
                    ext.replaceWithText('Request');
                }
            }
        }
    },

    /** Transform `extends JSONRPCNotification` → `extends Notification` */
    extendsJSONRPCNotification(sourceFile: SourceFile) {
        for (const iface of sourceFile.getInterfaces()) {
            for (const ext of iface.getExtends()) {
                if (ext.getText() === 'JSONRPCNotification') {
                    ext.replaceWithText('Notification');
                }
            }
        }
    },

    /** Inject RELATED_TASK_META_KEY into RequestParams._meta */
    injectRelatedTaskMetaKey: injectRelatedTaskMetaKey,

    /** Update Request.params and Notification.params types */
    updateRequestParamsType: updateRequestParamsType,

    /** Inline JSONRPCResponse into JSONRPCMessage union */
    inlineJSONRPCResponse: inlineJSONRPCResponse,

    /** Inject SDK-specific extensions (e.g., applyDefaults) */
    injectSdkExtensions: injectSdkExtensions,

    /** Convert JSDoc comments to @description for .describe() generation */
    convertJsDocToDescription: convertJsDocToDescription,

    /** Add derived capability types (ClientTasksCapability, etc.) */
    injectDerivedCapabilityTypes: injectDerivedCapabilityTypes,
};

/**
 * Type cleanup transforms applied after main transforms.
 * These prepare types for clean SDK export.
 */
const TypeCleanupTransforms = {
    /** Remove standalone index signatures from interfaces */
    removeIndexSignatures(sourceFile: SourceFile) {
        let count = 0;
        for (const iface of sourceFile.getInterfaces()) {
            const indexSigs = iface.getIndexSignatures();
            for (const sig of indexSigs) {
                sig.remove();
                count++;
            }
        }
        if (count > 0) {
            console.log(`      ✓ Removed ${count} standalone index signatures`);
        }
    },

    /** Create union types (McpRequest, McpNotification, McpResult) */
    createUnionTypes: createUnionTypes,
};

// =============================================================================
// Schema Transforms (generated Zod → final SDK schemas)
// =============================================================================

/**
 * Schema transforms applied to ts-to-zod output.
 * These adapt generated schemas for SDK conventions and Zod v4.
 * Order matters: transforms are applied in property definition order.
 */
const SchemaTransforms = {
    /** Transform z.record().and(z.object()) → z.object().passthrough() */
    recordAndToPassthrough: recordAndToPassthrough,

    /** Transform typeof expressions (z.any() → z.literal("2.0")) */
    typeofToLiteral: typeofToLiteral,

    /** Add .int() refinement to integer schemas */
    integerRefinements: integerRefinements,

    /** Add .default([]) to content arrays for backwards compat */
    arrayDefaults: arrayDefaults,

    /** Reorder union members (specific before general) */
    reorderUnionMembers: reorderUnionMembers,

    /** Convert z.union of literals to z.enum */
    unionToEnum: unionToEnum,

    /** Apply field-level validation overrides */
    fieldOverrides: fieldOverrides,

    /** Add .strict() to JSON-RPC schemas */
    strictSchemas: strictSchemas,

    /** Convert z.union to z.discriminatedUnion for tagged unions */
    discriminatedUnion: discriminatedUnion,

    /** Add .describe() to top-level schemas */
    topLevelDescribe: topLevelDescribe,

    /** Add AssertObjectSchema for capability schemas */
    assertObjectSchema: assertObjectSchema,

    /** Add z.preprocess for elicitation backwards compat */
    elicitationPreprocess: elicitationPreprocess,

    /** Convert capability schemas to looseObject */
    capabilitiesToLooseObject: capabilitiesToLooseObject,
};

// =============================================================================
// Type Transform Implementations
// =============================================================================

/**
 * Pre-process spec.types.ts using ts-morph to transform for SDK compatibility.
 */
function transformTypesForSdk(content: string): string {
    return applyTransforms(content, Object.values(TypeTransforms), 'Transforming types for SDK');
}

/**
 * Apply cleanup transforms to prepare types for export.
 */
function cleanupTypesForExport(content: string): string {
    return applyTransforms(content, Object.values(TypeCleanupTransforms), 'Cleaning up types for export');
}


/**
 * Check if an interface transitively extends a base interface.
 */
function extendsBase(
    iface: InterfaceDeclaration,
    baseName: string,
    sourceFile: SourceFile,
    checked: Set<string> = new Set()
): boolean {
    const name = iface.getName();
    if (checked.has(name)) return false;
    checked.add(name);

    for (const ext of iface.getExtends()) {
        // Handle generic types like "Foo<T>" -> "Foo"
        const extName = ext.getText().split('<')[0].trim();
        if (extName === baseName) return true;

        const parent = sourceFile.getInterface(extName);
        if (parent && extendsBase(parent, baseName, sourceFile, checked)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if a type alias references a base type (e.g., `type EmptyResult = Result`).
 */
function referencesBase(alias: TypeAliasDeclaration, baseName: string): boolean {
    const typeText = alias.getTypeNode()?.getText() || '';
    // Match patterns like "Result", "Result & Foo", "Foo & Result"
    const pattern = new RegExp(`\\b${baseName}\\b`);
    return pattern.test(typeText);
}

/**
 * Auto-discover union members by finding types that extend/reference a base type.
 *
 * Finds:
 * - Interfaces that transitively extend the base (e.g., ListResourcesRequest → PaginatedRequest → Request)
 * - Type aliases that reference the base (e.g., type EmptyResult = Result)
 *
 * Filters by naming convention (*Request, *Notification, *Result) and excludes abstract bases.
 */
function findUnionMembers(
    sourceFile: SourceFile,
    baseName: string,
    exclusions: Set<string>
): string[] {
    const members: string[] = [];

    // Find interfaces that extend base (transitively)
    for (const iface of sourceFile.getInterfaces()) {
        const name = iface.getName();
        if (exclusions.has(name)) continue;
        if (!name.endsWith(baseName)) continue;
        if (extendsBase(iface, baseName, sourceFile)) {
            members.push(name);
        }
    }

    // Find type aliases that reference base
    for (const alias of sourceFile.getTypeAliases()) {
        const name = alias.getName();
        if (exclusions.has(name)) continue;
        if (!name.endsWith(baseName)) continue;
        // Skip union types we're creating (McpRequest, etc.)
        if (name.startsWith('Mcp')) continue;
        // Skip Client/Server subsets
        if (name.startsWith('Client') || name.startsWith('Server')) continue;
        if (referencesBase(alias, baseName)) {
            members.push(name);
        }
    }

    return members.sort();
}

/**
 * Create union types (McpRequest, McpNotification, McpResult) from discovered members.
 *
 * Auto-discovers types that extend/reference base types and creates unions for type narrowing.
 */
function createUnionTypes(sourceFile: SourceFile): void {
    const baseNames = ['Request', 'Notification', 'Result'];

    for (const baseName of baseNames) {
        const baseInterface = sourceFile.getInterface(baseName);
        if (!baseInterface) {
            console.warn(`      ⚠️ Interface ${baseName} not found`);
            continue;
        }

        // Auto-discover union members
        const unionMembers = findUnionMembers(sourceFile, baseName, UNION_EXCLUSIONS);

        if (unionMembers.length === 0) {
            console.warn(`      ⚠️ No members found for ${baseName}`);
            continue;
        }

        // Create union type with Mcp prefix
        const unionName = `Mcp${baseName}`;
        const unionType = unionMembers.join('\n    | ');
        const insertPos = baseInterface.getEnd();
        sourceFile.insertText(
            insertPos,
            `\n\n/** Union of all MCP ${baseName.toLowerCase()} types for type narrowing. */\nexport type ${unionName} =\n    | ${unionType};`
        );

        console.log(`      ✓ Created ${unionName} with ${unionMembers.length} members`);
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

/**
 * Inline JSONRPCResponse into JSONRPCMessage and remove JSONRPCResponse type.
 * This allows types.ts to define these as schema unions locally.
 *
 * Transforms:
 *   type JSONRPCMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResponse;
 *   type JSONRPCResponse = JSONRPCResultResponse | JSONRPCErrorResponse;
 * Into:
 *   type JSONRPCMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResultResponse | JSONRPCErrorResponse;
 *   (JSONRPCResponse removed)
 */
function inlineJSONRPCResponse(sourceFile: SourceFile): void {
    // Find and update JSONRPCMessage
    const messageType = sourceFile.getTypeAlias('JSONRPCMessage');
    if (messageType) {
        const typeNode = messageType.getTypeNode();
        if (typeNode) {
            const text = typeNode.getText();
            // Replace JSONRPCResponse with its components
            const newType = text.replace('JSONRPCResponse', 'JSONRPCResultResponse | JSONRPCErrorResponse');
            messageType.setType(newType);
            console.log('    ✓ Inlined JSONRPCResponse into JSONRPCMessage');
        }
    }

    // Remove JSONRPCResponse type alias
    const responseType = sourceFile.getTypeAlias('JSONRPCResponse');
    if (responseType) {
        responseType.remove();
        console.log('    ✓ Removed JSONRPCResponse type (defined locally in types.ts)');
    }
}

/**
 * Inject SDK-specific extensions to spec types.
 * These are fields/types that the SDK adds beyond what the spec defines.
 */
function injectSdkExtensions(sourceFile: SourceFile): void {
    // Add applyDefaults to ClientCapabilities.elicitation.form
    // The SDK allows clients to request that servers apply schema defaults to elicitation responses
    const clientCaps = sourceFile.getInterface('ClientCapabilities');
    if (clientCaps) {
        const elicitationProp = clientCaps.getProperty('elicitation');
        if (elicitationProp) {
            const typeNode = elicitationProp.getTypeNode();
            if (typeNode) {
                const originalType = typeNode.getText();
                // Replace { form?: object; url?: object } with extended form type
                if (originalType.includes('form?: object')) {
                    const newType = originalType.replace('form?: object', 'form?: { applyDefaults?: boolean; [key: string]: unknown }');
                    typeNode.replaceWithText(newType);
                    console.log('    ✓ Added applyDefaults to ClientCapabilities.elicitation.form');
                }
            }
        }
    }
}

/**
 * Add derived capability types by extracting nested properties from parent interfaces.
 * This creates concrete interface definitions that ts-to-zod can generate schemas for.
 *
 * Example: ClientCapabilities.tasks becomes a standalone ClientTasksCapability interface.
 */
function injectDerivedCapabilityTypes(sourceFile: SourceFile): void {
    for (const [typeName, { parent, property }] of Object.entries(DERIVED_CAPABILITY_TYPES)) {
        // Check if already exists
        if (sourceFile.getInterface(typeName) || sourceFile.getTypeAlias(typeName)) {
            console.log(`    - ${typeName} already exists`);
            continue;
        }

        // Find the parent interface
        const parentInterface = sourceFile.getInterface(parent);
        if (!parentInterface) {
            console.warn(`    ⚠️  Parent interface ${parent} not found for ${typeName}`);
            continue;
        }

        // Find the property
        const prop = parentInterface.getProperty(property);
        if (!prop) {
            console.warn(`    ⚠️  Property ${property} not found in ${parent} for ${typeName}`);
            continue;
        }

        // Get the type text and remove the optional marker if present
        const typeNode = prop.getTypeNode();
        if (!typeNode) {
            console.warn(`    ⚠️  No type node for ${parent}.${property}`);
            continue;
        }

        let typeText = typeNode.getText();
        // Remove trailing '?' or '| undefined' to get the non-optional type
        typeText = typeText.replace(/\s*\|\s*undefined\s*$/, '').trim();

        // Get the JSDoc comment from the parent property for @description
        const jsDocs = prop.getJsDocs();
        const description = jsDocs.length > 0 ? jsDocs[0].getDescription().trim() : '';

        // Create the derived type alias with @description for .describe() generation
        sourceFile.addTypeAlias({
            name: typeName,
            isExported: true,
            type: typeText,
            docs: [description ? `@description ${description}` : `Extracted from ${parent}["${property}"].`]
        });
        console.log(`    ✓ Added derived type: ${typeName} from ${parent}.${property}`);
    }
}

/**
 * Convert JSDoc comments to @description tags so ts-to-zod generates .describe() calls.
 *
 * Transforms comments like:
 *   /** The progress thus far. * /
 * To:
 *   /** @description The progress thus far. * /
 */
function convertJsDocToDescription(sourceFile: SourceFile): void {
    let count = 0;

    // Process all interfaces and their nested type literals
    for (const iface of sourceFile.getInterfaces()) {
        // Convert interface-level JSDoc
        count += convertNodeJsDoc(iface);

        // Convert property-level JSDoc (including nested type literals)
        count += processPropertiesRecursively(iface);
    }

    // Process all type aliases
    for (const typeAlias of sourceFile.getTypeAliases()) {
        count += convertNodeJsDoc(typeAlias);
    }

    console.log(`    ✓ Converted ${count} JSDoc comments to @description`);
}

/**
 * Recursively process properties, including those in inline type literals.
 */
function processPropertiesRecursively(node: { getProperties?: () => Array<unknown>; getTypeNode?: () => unknown }): number {
    let count = 0;

    // Process direct properties
    if (node.getProperties) {
        for (const prop of node.getProperties() as Array<{ getJsDocs: () => unknown[]; getTypeNode?: () => unknown }>) {
            count += convertNodeJsDoc(prop as Parameters<typeof convertNodeJsDoc>[0]);

            // Check if the property has an inline type literal
            if (prop.getTypeNode) {
                const typeNode = prop.getTypeNode();
                if (typeNode && typeof typeNode === 'object' && 'getProperties' in typeNode) {
                    count += processPropertiesRecursively(typeNode as { getProperties: () => Array<unknown> });
                }
            }
        }
    }

    return count;
}

/**
 * Convert a node's JSDoc comment to use @description tag.
 * Returns 1 if converted, 0 otherwise.
 */
function convertNodeJsDoc(node: {
    getJsDocs: () => Array<{
        getDescription: () => string;
        getTags: () => Array<{ getTagName: () => string }>;
        replaceWithText: (text: string) => void;
    }>;
}): number {
    const jsDocs = node.getJsDocs();
    if (jsDocs.length === 0) return 0;

    const jsDoc = jsDocs[0];
    const description = jsDoc.getDescription().trim();

    // Skip if no description or already has @description tag
    if (!description) return 0;
    if (jsDoc.getTags().some(tag => tag.getTagName() === 'description')) return 0;

    // Get existing tags to preserve them
    const existingTags = jsDoc
        .getTags()
        .map(tag => {
            const tagName = tag.getTagName();
            const tagText = tag
                .getText()
                .replace(new RegExp(`^@${tagName}\\s*`), '')
                .trim();
            return `@${tagName}${tagText ? ' ' + tagText : ''}`;
        })
        .join('\n * ');

    // Build new JSDoc with @description
    const newJsDoc = existingTags ? `/**\n * @description ${description}\n * ${existingTags}\n */` : `/** @description ${description} */`;

    jsDoc.replaceWithText(newJsDoc);
    return 1;
}

// =============================================================================
// Schema Transform Implementations
// =============================================================================

/**
 * Transform generated schemas for SDK compatibility and Zod v4.
 */
function transformGeneratedSchemas(content: string): string {
    // Text-based transforms (simple replacements)
    content = content.replace('import { z } from "zod";', 'import { z } from "zod/v4";');
    content = content.replace(
        '// Generated by ts-to-zod',
        `// Generated by ts-to-zod
// Transformed for SDK compatibility (Zod v4, validation, discriminated unions, etc.)
// DO NOT EDIT - Run: npm run generate:schemas`
    );

    // Add .passthrough() to outputSchema
    const outputSchemaPattern = /(outputSchema:\s*z\.object\(\{[\s\S]*?\}\))(\.optional\(\))/g;
    if (outputSchemaPattern.test(content)) {
        content = content.replace(outputSchemaPattern, '$1.passthrough()$2');
        console.log('    ✓ Added .passthrough() to ToolSchema.outputSchema');
    }

    // AST-based transforms
    return applyTransforms(content, Object.values(SchemaTransforms), 'Transforming generated schemas');
}

/**
 * Transform z.record(z.string(), z.unknown()).and(z.object({...})) to z.object({...}).passthrough()
 *
 * Using .passthrough() instead of looseObject because:
 * - looseObject adds [x: string]: unknown index signature to the inferred type
 * - This breaks TypeScript union narrowing (can't check 'prop' in obj)
 * - .passthrough() allows extra properties at runtime without affecting the type
 */
function recordAndToPassthrough(sourceFile: SourceFile): void {
    // Find all call expressions
    sourceFile.forEachDescendant(node => {
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

        // Replace with z.object({...}).passthrough()
        // This allows extra properties at runtime but doesn't add index signature to type
        const objectContent = objectLiteral.getText();
        node.replaceWithText(`z.object(${objectContent}).passthrough()`);
    });
}

/**
 * Transform typeof expressions that became z.any() into proper literals.
 */
function typeofToLiteral(sourceFile: SourceFile): void {
    // Find property assignments with jsonrpc: z.any()
    sourceFile.forEachDescendant(node => {
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
function integerRefinements(sourceFile: SourceFile): void {
    for (const schemaName of INTEGER_SCHEMAS) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) continue;

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        // Collect nodes first to avoid modifying while iterating
        const nodesToReplace: CallExpression[] = [];
        initializer.forEachDescendant(node => {
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
 * Add .default([]) to array fields for backwards compatibility.
 * The SDK historically made certain content arrays optional with empty defaults.
 */
function arrayDefaults(sourceFile: SourceFile): void {
    for (const [schemaName, fieldNames] of Object.entries(ARRAY_DEFAULT_FIELDS)) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) continue;

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        // Find property assignments for the target fields
        initializer.forEachDescendant(node => {
            if (!Node.isPropertyAssignment(node)) return;

            const propName = node.getName();
            if (!fieldNames.includes(propName)) return;

            // Get the initializer (the value assigned to the property)
            const propInit = node.getInitializer();
            if (!propInit) return;

            const propText = propInit.getText();
            // Only add .default([]) if it's a z.array() and doesn't already have .default()
            if (propText.includes('z.array(') && !propText.includes('.default(')) {
                // Append .default([]) to the existing expression
                propInit.replaceWithText(propText + '.default([])');
            }
        });
    }
}

/**
 * Reorder union members according to UNION_MEMBER_ORDER configuration.
 * This ensures more specific schemas are matched before general ones.
 */
function reorderUnionMembers(sourceFile: SourceFile): void {
    for (const [schemaName, desiredOrder] of Object.entries(UNION_MEMBER_ORDER)) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) continue;

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        // Find the z.union([...]) call
        let unionCall: CallExpression | undefined;
        initializer.forEachDescendant(node => {
            if (!Node.isCallExpression(node)) return;
            const expr = node.getExpression();
            if (!Node.isPropertyAccessExpression(expr)) return;
            if (expr.getName() === 'union') {
                unionCall = node;
            }
        });

        if (!unionCall) {
            // Handle case where it's directly z.union(...) at top level
            if (Node.isCallExpression(initializer)) {
                const expr = initializer.getExpression();
                if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'union') {
                    unionCall = initializer;
                }
            }
        }

        if (!unionCall) continue;

        const args = unionCall.getArguments();
        if (args.length !== 1) continue;

        const arrayArg = args[0];
        if (!Node.isArrayLiteralExpression(arrayArg)) continue;

        // Get current member names
        const elements = arrayArg.getElements();
        const currentMembers = elements.map(e => e.getText().trim());

        // Check if reordering is needed
        const orderedMembers = [...currentMembers].sort((a, b) => {
            const aIdx = desiredOrder.indexOf(a);
            const bIdx = desiredOrder.indexOf(b);
            // If not in desiredOrder, keep at end
            if (aIdx === -1 && bIdx === -1) return 0;
            if (aIdx === -1) return 1;
            if (bIdx === -1) return -1;
            return aIdx - bIdx;
        });

        if (JSON.stringify(currentMembers) !== JSON.stringify(orderedMembers)) {
            arrayArg.replaceWithText('[' + orderedMembers.join(', ') + ']');
            console.log(`    ✓ Reordered ${schemaName} union members`);
        }
    }
}

/**
 * Transform z.union([z.literal('a'), z.literal('b'), ...]) to z.enum(['a', 'b', ...])
 *
 * This handles cases that the regex approach missed, including chained methods.
 */
function unionToEnum(sourceFile: SourceFile): void {
    // Collect union nodes that should be converted
    const nodesToReplace: Array<{ node: CallExpression; values: string[] }> = [];

    sourceFile.forEachDescendant(node => {
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
function fieldOverrides(sourceFile: SourceFile): void {
    for (const [schemaName, fields] of Object.entries(FIELD_OVERRIDES)) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) {
            console.warn(`    ⚠️  Schema not found for override: ${schemaName}`);
            continue;
        }

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        // Find property assignments matching the field names
        initializer.forEachDescendant(node => {
            if (!Node.isPropertyAssignment(node)) return;

            const propName = node.getName();
            if (fields[propName]) {
                console.log(`    ✓ Override: ${schemaName}.${propName}`);
                node.setInitializer(fields[propName]);
            }
        });
    }
}

/**
 * Add .strict() to specified schemas for stricter validation.
 * This matches the SDK's behavior of rejecting unknown properties.
 */
function strictSchemas(sourceFile: SourceFile): void {
    for (const schemaName of STRICT_SCHEMAS) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) continue;

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        // Append .strict() to the schema
        const currentText = initializer.getText();
        varDecl.setInitializer(`${currentText}.strict()`);
        console.log(`    ✓ Added .strict() to ${schemaName}`);
    }
}

/**
 * Convert z.union() to z.discriminatedUnion() for specified schemas.
 * This provides better performance and error messages for tagged unions.
 */
function discriminatedUnion(sourceFile: SourceFile): void {
    for (const [schemaName, discriminator] of Object.entries(DISCRIMINATED_UNIONS)) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) continue;

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        const text = initializer.getText();

        // Match z.union([...]) pattern and convert to z.discriminatedUnion('discriminator', [...])
        const unionMatch = text.match(/^z\.union\(\s*\[([\s\S]*)\]\s*\)$/);
        if (unionMatch) {
            const members = unionMatch[1];
            varDecl.setInitializer(`z.discriminatedUnion('${discriminator}', [${members}])`);
            console.log(`    ✓ Converted ${schemaName} to discriminatedUnion('${discriminator}')`);
        }
    }
}

/**
 * Add .describe() to top-level schemas based on their JSDoc @description tag.
 * ts-to-zod only adds .describe() to properties, not to the schema itself.
 */
function topLevelDescribe(sourceFile: SourceFile): void {
    let count = 0;

    for (const varStmt of sourceFile.getVariableStatements()) {
        // Get JSDoc from the variable statement
        const jsDocs = varStmt.getJsDocs();
        if (jsDocs.length === 0) continue;

        const jsDoc = jsDocs[0];
        const descTag = jsDoc.getTags().find(tag => tag.getTagName() === 'description');
        if (!descTag) continue;

        // Get the description text
        const descText = descTag.getCommentText()?.trim();
        if (!descText) continue;

        // Get the variable declaration
        const decl = varStmt.getDeclarations()[0];
        if (!decl) continue;

        const schemaName = decl.getName();
        if (!schemaName.endsWith('Schema')) continue;

        const initializer = decl.getInitializer();
        if (!initializer) continue;

        const currentText = initializer.getText();

        // Skip if already has .describe() at the end
        if (/\.describe\([^)]+\)\s*$/.test(currentText)) continue;

        // Escape backslashes first, then quotes and newlines
        const escapedDesc = descText.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');

        // Add .describe() to the schema
        decl.setInitializer(`${currentText}.describe('${escapedDesc}')`);
        count++;
    }

    if (count > 0) {
        console.log(`    ✓ Added .describe() to ${count} top-level schemas`);
    }
}

/**
 * Schemas where z.record(z.string(), z.any()) should be replaced with AssertObjectSchema.
 * These are capability schemas that use `object` type for extensibility.
 */
const ASSERT_OBJECT_SCHEMAS = [
    'ClientCapabilitiesSchema',
    'ServerCapabilitiesSchema',
    'ClientTasksCapabilitySchema',
    'ServerTasksCapabilitySchema'
];

/**
 * Add AssertObjectSchema definition and replace z.record(z.string(), z.any()) with it
 * in capability schemas. This provides better TypeScript typing (object vs { [x: string]: any }).
 */
function assertObjectSchema(sourceFile: SourceFile): void {
    // Check if any of the target schemas exist
    const hasTargetSchemas = ASSERT_OBJECT_SCHEMAS.some(name => sourceFile.getVariableDeclaration(name));
    if (!hasTargetSchemas) return;

    // Add AssertObjectSchema definition after imports
    const lastImport = sourceFile.getImportDeclarations().at(-1);
    if (lastImport) {
        lastImport.replaceWithText(`${lastImport.getText()}

/**
 * Assert 'object' type schema - validates that value is a non-null object.
 * Provides better TypeScript typing than z.record(z.string(), z.any()).
 * @internal
 */
const AssertObjectSchema = z.custom<object>((v): v is object => v !== null && (typeof v === 'object' || typeof v === 'function'));`);
    }

    // Replace z.record(z.string(), z.any()) with AssertObjectSchema in target schemas
    let count = 0;
    for (const schemaName of ASSERT_OBJECT_SCHEMAS) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) continue;

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        const text = initializer.getText();
        // Replace the pattern - note we need to handle optional() suffix too
        const newText = text.replace(/z\.record\(z\.string\(\), z\.any\(\)\)/g, 'AssertObjectSchema');

        if (newText !== text) {
            varDecl.setInitializer(newText);
            count++;
        }
    }

    if (count > 0) {
        console.log(`    ✓ Replaced z.record(z.string(), z.any()) with AssertObjectSchema in ${count} schemas`);
    }
}

/**
 * Convert capability schemas to use looseObject for extensibility.
 * The spec says capabilities are "not a closed set" - any client/server can define
 * additional capabilities. Using looseObject allows extra properties.
 */
function capabilitiesToLooseObject(sourceFile: SourceFile): void {
    const CAPABILITY_SCHEMAS = [
        'ClientCapabilitiesSchema',
        'ServerCapabilitiesSchema',
        'ClientTasksCapabilitySchema',
        'ServerTasksCapabilitySchema'
    ];

    let count = 0;
    for (const schemaName of CAPABILITY_SCHEMAS) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) continue;

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        const text = initializer.getText();
        // Replace z.object( with z.looseObject( for nested objects in capabilities
        // This allows extensibility for additional capability properties
        const newText = text.replace(/z\.object\(/g, 'z.looseObject(');

        if (newText !== text) {
            varDecl.setInitializer(newText);
            count++;
        }
    }

    if (count > 0) {
        console.log(`    ✓ Converted ${count} capability schemas to use looseObject for extensibility`);
    }
}

/**
 * Add z.preprocess to ClientCapabilitiesSchema.elicitation for backwards compatibility.
 * - preprocess: transforms empty {} to { form: {} } for SDK backwards compatibility
 * - keeps original schema structure to maintain type compatibility with spec
 */
function elicitationPreprocess(sourceFile: SourceFile): void {
    const varDecl = sourceFile.getVariableDeclaration('ClientCapabilitiesSchema');
    if (!varDecl) return;

    const initializer = varDecl.getInitializer();
    if (!initializer) return;

    let text = initializer.getText();

    // Find the elicitation field and wrap with preprocess
    // Handle both z.object and z.looseObject patterns
    // The inner schema structure may be complex (nested objects, etc.), so we use brace counting
    const elicitationStart = text.indexOf('elicitation:');
    if (elicitationStart === -1) return;

    // Find the schema after 'elicitation:'
    const afterElicitation = text.substring(elicitationStart + 'elicitation:'.length);

    // Find where z.object or z.looseObject starts
    const objectMatch = afterElicitation.match(/^\s*(z\s*\.\s*(?:looseObject|object)\s*\()/);
    if (!objectMatch) return;

    const schemaStart = elicitationStart + 'elicitation:'.length + objectMatch.index!;

    // Count braces/parens to find the end of the schema (before .optional())
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let schemaEnd = schemaStart;
    const startPos = schemaStart;

    for (let i = startPos; i < text.length; i++) {
        const char = text[i];
        const prevChar = i > 0 ? text[i - 1] : '';

        if (inString) {
            if (char === stringChar && prevChar !== '\\') {
                inString = false;
            }
        } else {
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
            } else if (char === '(' || char === '{' || char === '[') {
                depth++;
            } else if (char === ')' || char === '}' || char === ']') {
                depth--;
                if (depth === 0) {
                    schemaEnd = i + 1;
                    break;
                }
            }
        }
    }

    // Extract the inner schema (z.looseObject({...}) or z.object({...}))
    const innerSchema = text.substring(schemaStart, schemaEnd).trim();

    // Find what follows the schema (.optional().describe(...) etc)
    const afterSchema = text.substring(schemaEnd);
    const optionalMatch = afterSchema.match(/^\s*\.optional\(\)(\s*\.describe\([^)]*\))?/);
    if (!optionalMatch) return;

    const describeCall = optionalMatch[1] || '';
    const fullMatchEnd = schemaEnd + optionalMatch[0].length;

    // Build the replacement with preprocess
    const replacement = `elicitation: z.preprocess(
            value => {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    if (Object.keys(value as Record<string, unknown>).length === 0) {
                        return { form: {} };
                    }
                }
                return value;
            },
            ${innerSchema}${describeCall}
        ).optional()`;

    text = text.substring(0, elicitationStart) + replacement + text.substring(fullMatchEnd);
    varDecl.setInitializer(text);
    console.log('    ✓ Added z.preprocess to ClientCapabilitiesSchema.elicitation');
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    const ifChanged = process.argv.includes('--if-changed');

    if (ifChanged) {
        if (!needsRegeneration()) {
            console.log('✅ Schemas are up to date, skipping generation.');
            return;
        }
        console.log('🔄 Input files changed, regenerating schemas...\n');
    } else {
        console.log('🔧 Generating Zod schemas from spec.types.ts...\n');
    }

    // Ensure generated directory exists
    if (!existsSync(GENERATED_DIR)) {
        mkdirSync(GENERATED_DIR, { recursive: true });
    }

    // Phase 1: Transform types for SDK
    const rawSourceText = readFileSync(SPEC_TYPES_FILE, 'utf-8');
    const sdkTypesContent = transformTypesForSdk(rawSourceText);
    const cleanedTypesContent = cleanupTypesForExport(sdkTypesContent);

    // Write types with header
    const sdkTypesWithHeader = `/* eslint-disable @typescript-eslint/no-empty-object-type */
/**
 * SDK-compatible types generated from spec.types.ts
 *
 * This file is auto-generated by scripts/generate-schemas.ts
 * DO NOT EDIT MANUALLY
 *
 * Transformations applied:
 * - \`extends JSONRPCRequest\` → \`extends Request\`
 * - \`extends JSONRPCNotification\` → \`extends Notification\`
 * - All index signature patterns removed (enables TypeScript union narrowing)
 *
 * Note: Schemas use .passthrough() for runtime extensibility, so types
 * don't need index signatures. This separation allows clean types for
 * TypeScript while maintaining runtime flexibility.
 */
${cleanedTypesContent.replace(/^\/\*\*[\s\S]*?\*\/\n/, '')}`;
    writeFileSync(SDK_TYPES_FILE, sdkTypesWithHeader, 'utf-8');
    console.log(`✅ Written: ${SDK_TYPES_FILE}`);

    const result = generate({
        sourceText: sdkTypesContent,
        keepComments: true,
        skipParseJSDoc: false,
        // Use PascalCase naming to match existing types.ts convention
        getSchemaName: (typeName: string) => `${typeName}Schema`
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

    // Phase 2: Transform generated schemas
    let schemasContent = result.getZodSchemasFile('./sdk.types.js');
    schemasContent = transformGeneratedSchemas(schemasContent);

    writeFileSync(SCHEMA_OUTPUT_FILE, schemasContent, 'utf-8');
    console.log(`✅ Written: ${SCHEMA_OUTPUT_FILE}`);

    // Generate integration tests that verify schemas match TypeScript types
    const testsContent = result.getIntegrationTestFile('./sdk.types.js', './sdk.schemas.js');
    if (testsContent) {
        const processedTests = postProcessTests(testsContent);
        writeFileSync(SCHEMA_TEST_OUTPUT_FILE, processedTests, 'utf-8');
        console.log(`✅ Written: ${SCHEMA_TEST_OUTPUT_FILE}`);
    }

    // Format generated files with prettier
    console.log('\n📝 Formatting generated files...');
    execSync('npx prettier --write "src/generated/**/*"', {
        cwd: PROJECT_ROOT,
        stdio: 'inherit'
    });

    console.log('\n🎉 Schema generation complete!');
}

/**
 * Post-process generated integration tests.
 */
function postProcessTests(content: string): string {
    content = content.replace('import { z } from "zod";', 'import { z } from "zod/v4";');

    content = content.replace(
        '// Generated by ts-to-zod',
        `// Generated by ts-to-zod
// Integration tests verifying schemas match TypeScript types
// Run: npm run generate:schemas`
    );

    // Comment out bidirectional type checks for schemas that use looseObject or passthrough.
    // These add index signatures [x: string]: unknown to schema-inferred types, but
    // we've removed index signatures from spec types (for union narrowing).
    // The one-way check (schema-inferred → spec) is kept to ensure compatibility.
    const schemasWithIndexSignatures = [
        // Capability schemas use looseObject
        'ClientCapabilities',
        'ServerCapabilities',
        'ClientTasksCapability',
        'ServerTasksCapability',
        'InitializeResult',
        'InitializeRequestParams',
        'InitializeRequest',
        'ClientRequest', // Contains InitializeRequest
        // Result-based schemas use passthrough (Result extends removed index sig)
        'Result',
        'EmptyResult',
        'PaginatedResult',
        'JSONRPCResultResponse',
        'CreateTaskResult',
        'GetTaskResult',
        'CancelTaskResult',
        'ListTasksResult',
        'CompleteResult',
        'ElicitResult',
        'ListRootsResult',
        'ReadResourceResult',
        'ListToolsResult',
        'ListPromptsResult',
        'ListResourceTemplatesResult',
        'ListResourcesResult',
        'CallToolResult',
        'GetPromptResult',
        'CreateMessageResult',
        'GetTaskPayloadResult', // Has explicit Record<string, unknown> extension
        // Request/Notification based schemas also use passthrough
        'Request',
        'Notification',
        'RequestParams',
        'NotificationParams',
        // Union types that include passthrough schemas
        'JSONRPCMessage'
    ];

    let commentedCount = 0;
    for (const schemaName of schemasWithIndexSignatures) {
        // Comment out spec → schema-inferred checks (these fail with passthrough/looseObject)
        // ts-to-zod generates PascalCase type names
        // Pattern matches: expectType<FooSchemaInferredType>({} as spec.Foo)
        const pattern = new RegExp(`(expectType<${schemaName}SchemaInferredType>\\(\\{\\} as spec\\.${schemaName}\\))`, 'g');
        const before = content;
        content = content.replace(
            pattern,
            `// Skip: passthrough/looseObject index signature incompatible with clean spec interface\n// $1`
        );
        if (before !== content) {
            commentedCount++;
        }
    }
    if (commentedCount > 0) {
        console.log(`    ✓ Commented out ${commentedCount} index-signature type checks in test file`);
    }

    // Union types: Request, Notification, Result are now union types, so schema-inferred
    // (which is object type) can't be assigned to them. Comment out both directions.
    const unionTypes = ['Request', 'Notification', 'Result'];
    let unionCommentedCount = 0;
    for (const typeName of unionTypes) {
        // Comment out schema-inferred → spec checks (schema object can't satisfy union)
        const specPattern = new RegExp(`(expectType<spec\\.${typeName}>\\(\\{\\} as ${typeName}SchemaInferredType\\))`, 'g');
        const before = content;
        content = content.replace(specPattern, `// Skip: schema-inferred object type incompatible with spec union type\n// $1`);
        if (before !== content) {
            unionCommentedCount++;
        }
    }
    if (unionCommentedCount > 0) {
        console.log(`    ✓ Commented out ${unionCommentedCount} union type checks in test file`);
    }

    return content;
}

main().catch(error => {
    console.error('❌ Schema generation failed:', error);
    process.exit(1);
});
