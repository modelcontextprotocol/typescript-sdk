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
 *    - Add `.default([])` to content arrays for backwards compatibility
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

/**
 * Fields that need .default([]) for backwards compatibility.
 * The SDK historically made these optional with empty array defaults.
 */
const ARRAY_DEFAULT_FIELDS: Record<string, string[]> = {
    'CallToolResultSchema': ['content'],
    'ToolResultContentSchema': ['content'],
};

/**
 * Schemas that need .strict() added for stricter validation.
 */
const STRICT_SCHEMAS = [
    'JSONRPCRequestSchema',
    'JSONRPCNotificationSchema',
    'JSONRPCResultResponseSchema',
    'JSONRPCErrorResponseSchema',
    'EmptyResultSchema',
];

/**
 * Schemas that should use z.discriminatedUnion instead of z.union for better performance.
 * Maps schema name to the discriminator field name.
 */
const DISCRIMINATED_UNIONS: Record<string, string> = {
    'SamplingContentSchema': 'type',
    'SamplingMessageContentBlockSchema': 'type',
    'ContentBlockSchema': 'type',
};

/**
 * Derived capability types to add during pre-processing.
 * These are extracted from parent capability interfaces for convenience.
 * Format: { typeName: { parent: 'ParentInterface', property: 'propertyName' } }
 */
const DERIVED_CAPABILITY_TYPES: Record<string, { parent: string; property: string }> = {
    'ClientTasksCapability': { parent: 'ClientCapabilities', property: 'tasks' },
    'ServerTasksCapability': { parent: 'ServerCapabilities', property: 'tasks' },
    // Note: ElicitationCapability is kept local in types.ts because it has z.preprocess for backwards compat
};

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

    // Transform 5: Inline JSONRPCResponse into JSONRPCMessage and remove JSONRPCResponse
    // (types.ts will define these locally with proper schema unions)
    inlineJSONRPCResponse(sourceFile);

    // Transform 6: Convert JSDoc comments to @description tags for .describe() generation
    // (Must run before injectDerivedCapabilityTypes so inline types get @description)
    convertJsDocToDescription(sourceFile);

    // Transform 7: Add derived capability types (extracts from parent interfaces)
    injectDerivedCapabilityTypes(sourceFile);

    return sourceFile.getFullText();
}

/**
 * Remove standalone index signatures from interface bodies in sdk.types.ts.
 *
 * The MCP spec uses index signatures for extensibility, but they break TypeScript union narrowing.
 * We only remove STANDALONE index signatures from interface bodies, NOT:
 * - Intersection patterns in property types (needed for params extensibility)
 * - Index signatures inside nested objects like _meta
 *
 * Example of what we remove:
 *   interface Result {
 *     _meta?: {...};
 *     [key: string]: unknown;  // <-- This is removed
 *   }
 *
 * Example of what we keep:
 *   interface Request {
 *     params?: RequestParams & { [key: string]: any };  // <-- Kept (allows extra params)
 *   }
 */
function removeIndexSignaturesFromTypes(content: string): string {
    console.log('  🔧 Cleaning up index signatures for type exports...');

    let result = content;
    let count = 0;

    // Only remove standalone index signatures from interface bodies
    // These are lines that ONLY contain an index signature (with optional leading whitespace)
    // Pattern matches: `    [key: string]: unknown;\n`
    const standalonePattern = /^(\s*)\[key:\s*string\]:\s*unknown;\s*\n/gm;
    result = result.replace(standalonePattern, () => { count++; return ''; });

    console.log(`    ✓ Removed ${count} standalone index signatures`);

    return result;
}

/**
 * Configuration for converting base interfaces to union types.
 * Maps base interface name to its union members (the concrete types that extend it).
 */
const BASE_TO_UNION_CONFIG: Record<string, string[]> = {
    'Request': [
        'InitializeRequest',
        'PingRequest',
        'ListResourcesRequest',
        'ListResourceTemplatesRequest',
        'ReadResourceRequest',
        'SubscribeRequest',
        'UnsubscribeRequest',
        'ListPromptsRequest',
        'GetPromptRequest',
        'ListToolsRequest',
        'CallToolRequest',
        'SetLevelRequest',
        'CompleteRequest',
        'CreateMessageRequest',
        'ListRootsRequest',
        'ElicitRequest',
        'GetTaskRequest',
        'GetTaskPayloadRequest',
        'CancelTaskRequest',
        'ListTasksRequest',
    ],
    'Notification': [
        'CancelledNotification',
        'InitializedNotification',
        'ProgressNotification',
        'ResourceListChangedNotification',
        'ResourceUpdatedNotification',
        'PromptListChangedNotification',
        'ToolListChangedNotification',
        'LoggingMessageNotification',
        'RootsListChangedNotification',
        'TaskStatusNotification',
        'ElicitationCompleteNotification',
    ],
    'Result': [
        'EmptyResult',
        'InitializeResult',
        'CompleteResult',
        'GetPromptResult',
        'ListPromptsResult',
        'ListResourceTemplatesResult',
        'ListResourcesResult',
        'ReadResourceResult',
        'CallToolResult',
        'ListToolsResult',
        'CreateTaskResult',
        'GetTaskResult',
        'GetTaskPayloadResult',
        'ListTasksResult',
        'CancelTaskResult',
        'CreateMessageResult',
        'ListRootsResult',
        'ElicitResult',
    ],
};

/**
 * Convert base interfaces to union types in sdk.types.ts.
 *
 * This transforms:
 *   interface Result { _meta?: {...} }
 *   interface InitializeResult extends Result { ... }
 *
 * Into:
 *   interface Result { _meta?: {...} }  // Base stays as-is
 *   interface InitializeResult extends Result { ... }
 *   type McpResult = InitializeResult | CompleteResult | ...  // Union with Mcp prefix
 *
 * This enables TypeScript union narrowing while preserving backwards compatibility.
 * The base type keeps its original name, and the union gets an "Mcp" prefix.
 */
function convertBaseTypesToUnions(content: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('types.ts', content);

    console.log('  🔧 Converting base types to unions...');

    for (const [baseName, unionMembers] of Object.entries(BASE_TO_UNION_CONFIG)) {
        const baseInterface = sourceFile.getInterface(baseName);
        if (!baseInterface) {
            console.warn(`    ⚠️  Interface ${baseName} not found`);
            continue;
        }

        // Base interface keeps its original name (Request, Notification, Result)
        // Union type gets Mcp prefix (McpRequest, McpNotification, McpResult)
        const unionName = `Mcp${baseName}`;

        // Add the union type alias after the base interface
        const unionType = unionMembers.join(' | ');
        const insertPos = baseInterface.getEnd();
        sourceFile.insertText(insertPos, `\n\n/** Union of all MCP ${baseName.toLowerCase()} types for type narrowing. */\nexport type ${unionName} = ${unionType};`);

        console.log(`    ✓ Created ${unionName} as union of ${unionMembers.length} types`);
    }

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
            const newType = text.replace(
                'JSONRPCResponse',
                'JSONRPCResultResponse | JSONRPCErrorResponse'
            );
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
function convertNodeJsDoc(node: { getJsDocs: () => Array<{ getDescription: () => string; getTags: () => Array<{ getTagName: () => string }>; replaceWithText: (text: string) => void }> }): number {
    const jsDocs = node.getJsDocs();
    if (jsDocs.length === 0) return 0;

    const jsDoc = jsDocs[0];
    const description = jsDoc.getDescription().trim();

    // Skip if no description or already has @description tag
    if (!description) return 0;
    if (jsDoc.getTags().some(tag => tag.getTagName() === 'description')) return 0;

    // Get existing tags to preserve them
    const existingTags = jsDoc.getTags().map(tag => {
        const tagName = tag.getTagName();
        const tagText = tag.getText().replace(new RegExp(`^@${tagName}\\s*`), '').trim();
        return `@${tagName}${tagText ? ' ' + tagText : ''}`;
    }).join('\n * ');

    // Build new JSDoc with @description
    const newJsDoc = existingTags
        ? `/**\n * @description ${description}\n * ${existingTags}\n */`
        : `/** @description ${description} */`;

    jsDoc.replaceWithText(newJsDoc);
    return 1;
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
    transformArrayDefaults,
    transformUnionToEnum,
    applyFieldOverrides,
    addStrictToSchemas,
    convertToDiscriminatedUnion,
    addTopLevelDescribe,
    addAssertObjectSchema,
    addElicitationPreprocess,
    convertCapabilitiesToLooseObject,
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
 * Transform z.record(z.string(), z.unknown()).and(z.object({...})) to z.object({...}).passthrough()
 *
 * Using .passthrough() instead of looseObject because:
 * - looseObject adds [x: string]: unknown index signature to the inferred type
 * - This breaks TypeScript union narrowing (can't check 'prop' in obj)
 * - .passthrough() allows extra properties at runtime without affecting the type
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

        // Replace with z.object({...}).passthrough()
        // This allows extra properties at runtime but doesn't add index signature to type
        const objectContent = objectLiteral.getText();
        node.replaceWithText(`z.object(${objectContent}).passthrough()`);
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
 * Add .default([]) to array fields for backwards compatibility.
 * The SDK historically made certain content arrays optional with empty defaults.
 */
function transformArrayDefaults(sourceFile: SourceFile): void {
    for (const [schemaName, fieldNames] of Object.entries(ARRAY_DEFAULT_FIELDS)) {
        const varDecl = sourceFile.getVariableDeclaration(schemaName);
        if (!varDecl) continue;

        const initializer = varDecl.getInitializer();
        if (!initializer) continue;

        // Find property assignments for the target fields
        initializer.forEachDescendant((node) => {
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

/**
 * Add .strict() to specified schemas for stricter validation.
 * This matches the SDK's behavior of rejecting unknown properties.
 */
function addStrictToSchemas(sourceFile: SourceFile): void {
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
function convertToDiscriminatedUnion(sourceFile: SourceFile): void {
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
function addTopLevelDescribe(sourceFile: SourceFile): void {
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

        // Escape quotes in description
        const escapedDesc = descText.replace(/'/g, "\\'").replace(/\n/g, ' ');

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
    'ServerTasksCapabilitySchema',
];

/**
 * Add AssertObjectSchema definition and replace z.record(z.string(), z.any()) with it
 * in capability schemas. This provides better TypeScript typing (object vs { [x: string]: any }).
 */
function addAssertObjectSchema(sourceFile: SourceFile): void {
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
        const newText = text
            .replace(/z\.record\(z\.string\(\), z\.any\(\)\)/g, 'AssertObjectSchema');

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
function convertCapabilitiesToLooseObject(sourceFile: SourceFile): void {
    const CAPABILITY_SCHEMAS = [
        'ClientCapabilitiesSchema',
        'ServerCapabilitiesSchema',
        'ClientTasksCapabilitySchema',
        'ServerTasksCapabilitySchema',
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
function addElicitationPreprocess(sourceFile: SourceFile): void {
    const varDecl = sourceFile.getVariableDeclaration('ClientCapabilitiesSchema');
    if (!varDecl) return;

    const initializer = varDecl.getInitializer();
    if (!initializer) return;

    let text = initializer.getText();

    // Find the elicitation field and wrap with preprocess
    // Pattern: elicitation: z.object({ form: ..., url: ... }).optional().describe(...)
    // We need to capture everything up to and including the object's closing paren, then handle the trailing .optional().describe() separately
    const elicitationPattern = /elicitation:\s*(z\s*\.\s*object\(\s*\{[^}]*form:[^}]*url:[^}]*\}\s*\))\s*\.optional\(\)(\s*\.describe\([^)]*\))?/;

    const match = text.match(elicitationPattern);
    if (match) {
        const innerSchema = match[1]; // z.object({...}) without .optional()
        const describeCall = match[2] || ''; // .describe(...) if present
        const replacement = `elicitation: z.preprocess(
            (value) => {
                if (value && typeof value === 'object' && !Array.isArray(value)) {
                    if (Object.keys(value as Record<string, unknown>).length === 0) {
                        return { form: {} };
                    }
                }
                return value;
            },
            ${innerSchema}${describeCall}
        ).optional()`;

        text = text.replace(elicitationPattern, replacement);
        varDecl.setInitializer(text);
        console.log('    ✓ Added z.preprocess to ClientCapabilitiesSchema.elicitation');
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

    // Clean up types for SDK export - remove ALL index signature patterns
    // This enables TypeScript union narrowing while schemas handle runtime extensibility
    let cleanedTypesContent = removeIndexSignaturesFromTypes(sdkTypesContent);

    // Convert base types (Result) to unions for better type narrowing
    cleanedTypesContent = convertBaseTypesToUnions(cleanedTypesContent);

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
        'JSONRPCMessage',
    ];

    let commentedCount = 0;
    for (const schemaName of schemasWithIndexSignatures) {
        // Comment out spec → schema-inferred checks (these fail with passthrough/looseObject)
        // ts-to-zod generates PascalCase type names
        // Pattern matches: expectType<FooSchemaInferredType>({} as spec.Foo)
        const pattern = new RegExp(
            `(expectType<${schemaName}SchemaInferredType>\\(\\{\\} as spec\\.${schemaName}\\))`,
            'g'
        );
        const before = content;
        content = content.replace(pattern, `// Skip: passthrough/looseObject index signature incompatible with clean spec interface\n// $1`);
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
        const specPattern = new RegExp(
            `(expectType<spec\\.${typeName}>\\(\\{\\} as ${typeName}SchemaInferredType\\))`,
            'g'
        );
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

main().catch((error) => {
    console.error('❌ Schema generation failed:', error);
    process.exit(1);
});
