import type { CallExpression, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { actionRequired, info } from '../../../utils/diagnostics';
import { hasMcpImports, isOriginalNameImportedFromMcp, resolveLocalImportName } from '../../../utils/importUtils';

export const mcpServerApiTransform: Transform = {
    name: 'McpServer API migration',
    id: 'mcpserver-api',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        let changesCount = 0;

        const hasServerImport = isOriginalNameImportedFromMcp(sourceFile, 'McpServer');
        if (!hasServerImport && !hasMcpImports(sourceFile)) {
            return { changesCount: 0, diagnostics: [] };
        }
        // Without a direct McpServer import (harness objects exposing an `mcp` field,
        // wrapped servers), legacy-name calls still migrate when their shape provably
        // matches the v1 signature; non-matching calls stay silent rather than
        // collecting hard markers on receivers whose type the codemod cannot see.
        const provableShapesOnly = !hasServerImport;

        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

        const toolCalls: CallExpression[] = [];
        const promptCalls: CallExpression[] = [];
        const resourceCalls: CallExpression[] = [];
        const registerToolCalls: CallExpression[] = [];
        const registerPromptCalls: CallExpression[] = [];
        const registerResourceCalls: CallExpression[] = [];

        for (const call of calls) {
            const expr = call.getExpression();
            if (!Node.isPropertyAccessExpression(expr)) continue;
            const methodName = expr.getName();

            const legacyPrequalified =
                !provableShapesOnly ||
                (call.getArguments().length >= 2 &&
                    isStringArg(call.getArguments()[0]!) &&
                    receiverLooksLikeMcpServer(expr.getExpression()));
            // The same receiver evidence gates the modern register* names: a file
            // with only an MCP type import can carry an unrelated
            // `registry.registerTool('x', { inputSchema }, cb)` whose schema must
            // not be wrapped.
            const registerQualified = !provableShapesOnly || receiverLooksLikeMcpServer(expr.getExpression());
            switch (methodName) {
                case 'tool': {
                    if (legacyPrequalified) toolCalls.push(call);
                    break;
                }
                case 'prompt': {
                    if (legacyPrequalified) promptCalls.push(call);
                    break;
                }
                case 'resource': {
                    if (legacyPrequalified) resourceCalls.push(call);
                    break;
                }
                case 'registerTool': {
                    if (registerQualified) registerToolCalls.push(call);
                    break;
                }
                case 'registerPrompt': {
                    if (registerQualified) registerPromptCalls.push(call);
                    break;
                }
                case 'registerResource': {
                    if (registerQualified) registerResourceCalls.push(call);
                    break;
                }
            }
        }

        // ONE pass in reverse document order across every category: a registration
        // nested inside another handler's body must migrate before the enclosing
        // call's rewrite replaces the surrounding text and forgets the inner node —
        // regardless of which category either call belongs to.
        interface PendingCall {
            call: CallExpression;
            kind: 'tool' | 'prompt' | 'resource' | 'registerTool' | 'registerPrompt' | 'registerResource';
        }
        const orderedCalls: PendingCall[] = [
            ...toolCalls.map(call => ({ call, kind: 'tool' as const })),
            ...promptCalls.map(call => ({ call, kind: 'prompt' as const })),
            ...resourceCalls.map(call => ({ call, kind: 'resource' as const })),
            ...registerToolCalls.map(call => ({ call, kind: 'registerTool' as const })),
            ...registerPromptCalls.map(call => ({ call, kind: 'registerPrompt' as const })),
            ...registerResourceCalls.map(call => ({ call, kind: 'registerResource' as const }))
        ].toSorted((a, b) => b.call.getPos() - a.call.getPos());

        const legacyFailure = (call: CallExpression, method: string): void => {
            // In fallback mode (no direct McpServer import) the receiver's type is
            // unknown — failures stay silent rather than marking non-MCP code.
            if (provableShapesOnly) return;
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    call,
                    `Could not automatically migrate .${method}() call. Manual migration required.`
                )
            );
        };

        for (const { call, kind } of orderedCalls) {
            if (call.wasForgotten()) continue;
            switch (kind) {
                case 'tool': {
                    if (migrateToolCall(call, sourceFile, diagnostics)) changesCount++;
                    else legacyFailure(call, 'tool');
                    break;
                }
                case 'prompt': {
                    if (migratePromptCall(call, sourceFile, diagnostics)) changesCount++;
                    else legacyFailure(call, 'prompt');
                    break;
                }
                case 'resource': {
                    if (migrateResourceCall(call, sourceFile)) changesCount++;
                    else legacyFailure(call, 'resource');
                    break;
                }
                case 'registerTool': {
                    if (wrapSchemaInConfig(call, 'inputSchema', sourceFile, diagnostics)) changesCount++;
                    if (!call.wasForgotten() && wrapSchemaInConfig(call, 'outputSchema', sourceFile, diagnostics)) changesCount++;
                    break;
                }
                case 'registerPrompt': {
                    if (wrapSchemaInConfig(call, 'argsSchema', sourceFile, diagnostics)) changesCount++;
                    break;
                }
                case 'registerResource': {
                    if (wrapSchemaInConfig(call, 'uriSchema', sourceFile, diagnostics)) changesCount++;
                    break;
                }
            }
        }

        flagRemovedTaskOptions(sourceFile, diagnostics);

        ensureZodImportForWraps(sourceFile, diagnostics);

        noteMockShapeAssertions(sourceFile, diagnostics);

        return { changesCount, diagnostics };
    }
};

function isStringArg(node: Node): boolean {
    return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateExpression(node);
}

function isZodObjectCall(node: Node): boolean {
    if (!Node.isCallExpression(node)) return false;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return false;
    return expr.getName() === 'object' && expr.getExpression().getText() === 'z';
}

const WRAP_NOTE = 'wrapped with z.object().';

function wrapWithZObject(schemaText: string): string {
    return `z.object(${schemaText})`;
}

function maybeWrapSchema(node: Node): string {
    const text = node.getText();
    if (Node.isObjectLiteralExpression(node)) {
        return wrapWithZObject(text);
    }
    return text;
}

function emitWrapDiagnostic(node: Node, sourceFile: SourceFile, call: CallExpression, diagnostics: Diagnostic[]): void {
    if (Node.isObjectLiteralExpression(node)) {
        diagnostics.push(info(sourceFile.getFilePath(), call.getStartLineNumber(), `Raw object literal ${WRAP_NOTE}`));
    } else if (!isZodObjectCall(node)) {
        diagnostics.push({
            ...actionRequired(
                sourceFile.getFilePath(),
                call,
                'Could not verify the schema argument is a schema object. Raw shapes are deprecated in v2 — ' +
                    'pass a Standard Schema object (e.g. z.object({ … })); no change is needed if it already is one.'
            ),
            advisoryOnly: true
        });
    }
}

/**
 * For existing registerTool/registerPrompt/registerResource calls,
 * wrap the specified schema property with z.object() if it's a raw object literal.
 */
function wrapSchemaInConfig(call: CallExpression, schemaPropertyName: string, sourceFile: SourceFile, diagnostics: Diagnostic[]): boolean {
    const args = call.getArguments();
    // registerTool/registerPrompt: (name, config, callback)
    // registerResource: (name, uri, config, callback)
    // Find the config argument by looking for an object literal
    let configArg: Node | undefined;
    for (const arg of args) {
        if (Node.isObjectLiteralExpression(arg)) {
            configArg = arg;
            break;
        }
    }

    if (!configArg || !Node.isObjectLiteralExpression(configArg)) return false;

    const schemaProp = configArg.getProperty(schemaPropertyName);
    if (!schemaProp) return false;

    if (Node.isShorthandPropertyAssignment(schemaProp)) {
        diagnostics.push({
            ...actionRequired(
                sourceFile.getFilePath(),
                call,
                `Shorthand \`{ ${schemaPropertyName} }\` in config: could not verify the value is a schema object. Raw shapes ` +
                    `are deprecated in v2 — pass a Standard Schema object (e.g. z.object({ … })).`
            ),
            advisoryOnly: true
        });
        return false;
    }

    if (!Node.isPropertyAssignment(schemaProp)) return false;

    const initializer = schemaProp.getInitializer();
    if (!initializer) return false;

    if (Node.isObjectLiteralExpression(initializer)) {
        const wrapped = wrapWithZObject(initializer.getText());
        initializer.replaceWithText(wrapped);
        diagnostics.push(
            info(sourceFile.getFilePath(), call.getStartLineNumber(), `Raw object literal in ${schemaPropertyName} ${WRAP_NOTE}`)
        );
        return true;
    }

    if (!isZodObjectCall(initializer)) {
        diagnostics.push({
            ...actionRequired(
                sourceFile.getFilePath(),
                call,
                `Could not verify \`${schemaPropertyName}\` is a schema object. Raw shapes are deprecated in v2 — ` +
                    `pass a Standard Schema object (e.g. z.object({ … })); no change is needed if it already is one.`
            ),
            advisoryOnly: true
        });
    }
    return false;
}

function migrateToolCall(call: CallExpression, sourceFile: SourceFile, diagnostics: Diagnostic[]): boolean {
    const args = call.getArguments();
    if (args.length < 2) return false;

    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return false;

    const nameArg = args[0]!;
    if (!isStringArg(nameArg)) return false;
    const nameText = nameArg.getText();

    let description: string | undefined;
    let schema: string | undefined;
    let annotations: string | undefined;
    let callbackText: string | undefined;

    switch (args.length) {
        case 2: {
            // server.tool(name, callback)
            callbackText = args[1]!.getText();

            break;
        }
        case 3: {
            const arg1 = args[1]!;
            if (isStringArg(arg1)) {
                // server.tool(name, description, callback)
                description = arg1.getText();
                callbackText = args[2]!.getText();
            } else {
                // server.tool(name, schema, callback)
                emitWrapDiagnostic(arg1, sourceFile, call, diagnostics);
                schema = maybeWrapSchema(arg1);
                callbackText = args[2]!.getText();
            }

            break;
        }
        case 4: {
            const arg1 = args[1]!;
            if (isStringArg(arg1)) {
                // server.tool(name, description, schema, callback)
                description = arg1.getText();
                emitWrapDiagnostic(args[2]!, sourceFile, call, diagnostics);
                schema = maybeWrapSchema(args[2]!);
            } else {
                // server.tool(name, schema, annotations, callback)
                emitWrapDiagnostic(arg1, sourceFile, call, diagnostics);
                schema = maybeWrapSchema(arg1);
                annotations = args[2]!.getText();
            }
            callbackText = args[3]!.getText();

            break;
        }
        case 5: {
            // server.tool(name, description, schema, annotations, callback)
            description = args[1]!.getText();
            emitWrapDiagnostic(args[2]!, sourceFile, call, diagnostics);
            schema = maybeWrapSchema(args[2]!);
            annotations = args[3]!.getText();
            callbackText = args[4]!.getText();

            break;
        }
        default: {
            return false;
        }
    }

    const configParts: string[] = [];
    if (description) configParts.push(`description: ${description}`);
    if (schema) configParts.push(`inputSchema: ${schema}`);
    if (annotations) configParts.push(`annotations: ${annotations}`);
    const configObj = configParts.length > 0 ? `{ ${configParts.join(', ')} }` : '{}';

    expr.getNameNode().replaceWithText('registerTool');
    for (let i = args.length - 1; i >= 0; i--) {
        call.removeArgument(i);
    }
    call.addArguments([nameText, configObj, callbackText!]);

    return true;
}

function migratePromptCall(call: CallExpression, sourceFile: SourceFile, diagnostics: Diagnostic[]): boolean {
    const args = call.getArguments();
    if (args.length < 2) return false;

    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return false;

    const nameArg = args[0]!;
    if (!isStringArg(nameArg)) return false;
    const nameText = nameArg.getText();

    let description: string | undefined;
    let schema: string | undefined;
    let callbackText: string | undefined;

    switch (args.length) {
        case 2: {
            callbackText = args[1]!.getText();

            break;
        }
        case 3: {
            const arg1 = args[1]!;
            if (isStringArg(arg1)) {
                description = arg1.getText();
                callbackText = args[2]!.getText();
            } else {
                emitWrapDiagnostic(arg1, sourceFile, call, diagnostics);
                schema = maybeWrapSchema(arg1);
                callbackText = args[2]!.getText();
            }

            break;
        }
        case 4: {
            description = args[1]!.getText();
            emitWrapDiagnostic(args[2]!, sourceFile, call, diagnostics);
            schema = maybeWrapSchema(args[2]!);
            callbackText = args[3]!.getText();

            break;
        }
        default: {
            return false;
        }
    }

    const configParts: string[] = [];
    if (description) configParts.push(`description: ${description}`);
    if (schema) configParts.push(`argsSchema: ${schema}`);
    const configObj = configParts.length > 0 ? `{ ${configParts.join(', ')} }` : '{}';

    expr.getNameNode().replaceWithText('registerPrompt');
    for (let i = args.length - 1; i >= 0; i--) {
        call.removeArgument(i);
    }
    call.addArguments([nameText, configObj, callbackText!]);

    return true;
}

function migrateResourceCall(call: CallExpression, _sourceFile: SourceFile): boolean {
    const args = call.getArguments();
    if (args.length < 3) return false;

    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return false;

    const nameArg = args[0]!;
    if (!isStringArg(nameArg)) return false;
    const nameText = nameArg.getText();

    const uriArg = args[1]!;
    const uriText = uriArg.getText();

    if (args.length === 3) {
        // server.resource(name, uri, callback) → server.registerResource(name, uri, {}, callback)
        expr.getNameNode().replaceWithText('registerResource');
        const callbackText = args[2]!.getText();
        for (let i = args.length - 1; i >= 0; i--) {
            call.removeArgument(i);
        }
        call.addArguments([nameText, uriText, '{}', callbackText]);
    } else if (args.length === 4) {
        // server.resource(name, uri, metadata, callback) → server.registerResource(name, uri, metadata, callback)
        // Already has metadata, just rename the method
        expr.getNameNode().replaceWithText('registerResource');
    } else {
        return false;
    }

    return true;
}

const TASK_OPTIONS = ['taskStore', 'taskMessageQueue'] as const;

/**
 * Flag v1 task runtime options on the McpServer constructor as removed.
 *
 * The experimental tasks runtime was removed in v2 (SEP-2663) with no replacement, so
 * these options cannot be migrated automatically. Emit an action-required diagnostic
 * matching the importMap removal entry for `experimental/tasks`; the source is left
 * untouched.
 */
function flagRemovedTaskOptions(sourceFile: SourceFile, diagnostics: Diagnostic[]): void {
    const localName = resolveLocalImportName(sourceFile, 'McpServer');
    if (!localName) return;

    for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (node.wasForgotten()) continue;
        const expr = node.getExpression();
        if (!Node.isIdentifier(expr) || expr.getText() !== localName) continue;

        const args = node.getArguments();
        if (args.length < 2) continue;

        const optionsArg = args[1]!;
        if (!Node.isObjectLiteralExpression(optionsArg)) continue;

        for (const propName of TASK_OPTIONS) {
            if (!optionsArg.getProperty(propName)) continue;
            diagnostics.push(
                actionRequired(
                    sourceFile.getFilePath(),
                    node,
                    `Remove '${propName}' from McpServer options — experimental tasks removed in v2 (SEP-2663 — tasks moved to the Extensions Track). No v2 equivalent.`
                )
            );
        }
    }
}

/**
 * Wrapping a raw shape introduces a `z.object(...)` reference. When the file has no
 * `z` binding, add `import { z } from 'zod'` so the rewrite does not leave a dangling
 * identifier; the package must also declare zod (the manifest summary warns when its
 * declared range cannot satisfy v2's >=4.2 floor).
 */
function ensureZodImportForWraps(sourceFile: SourceFile, diagnostics: Diagnostic[]): void {
    const wrapped = diagnostics.some(d => d.message.includes(WRAP_NOTE));
    if (!wrapped) return;
    // A value import named `z` (type-only imports are erased and cannot back a
    // runtime z.object() call).
    const zValueImport = sourceFile.getImportDeclarations().some(decl => {
        if (decl.isTypeOnly()) return false;
        if (decl.getNamespaceImport()?.getText() === 'z') return true;
        if (decl.getDefaultImport()?.getText() === 'z') return true;
        return decl.getNamedImports().some(ni => !ni.isTypeOnly() && (ni.getAliasNode()?.getText() ?? ni.getName()) === 'z');
    });
    if (zValueImport) return;
    // `z` bound some other way (a variable, or a destructured require) — adding an
    // import would redeclare it, and the existing binding may not be zod at all.
    const zOtherBinding =
        sourceFile.getVariableDeclaration('z') !== undefined ||
        sourceFile.getDescendantsOfKind(SyntaxKind.BindingElement).some(be => be.getName() === 'z');
    if (zOtherBinding) {
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                sourceFile.getImportDeclarations()[0] ?? sourceFile,
                `Raw shapes were ${WRAP_NOTE.slice(0, -1)}, but \`z\` in this file is not a value import from zod — ` +
                    'wire the wrapped schemas to your zod instance manually (zod >=4.2.0 satisfies v2).'
            )
        );
        return;
    }
    sourceFile.addImportDeclaration({ moduleSpecifier: 'zod', namedImports: ['z'] });
    diagnostics.push({
        ...info(
            sourceFile.getFilePath(),
            1,
            "Added `import { z } from 'zod'` for the wrapped raw shapes. The owning package must declare zod " +
                '(>=4.2.0 satisfies v2) — the manifest summary adds or warns accordingly.'
        ),
        tag: 'zod-injected'
    });
}

const SCHEMA_CONFIG_KEYS = new Set(['inputSchema', 'outputSchema', 'argsSchema', 'uriSchema']);

/**
 * `expect.objectContaining({ inputSchema: { … } })`-style call-shape assertions pin
 * the v1 registration config; after migration the schemas are wrapped (z.object) and
 * the literal shape no longer matches. The codemod cannot rewrite the assertion —
 * note it.
 */
function noteMockShapeAssertions(sourceFile: SourceFile, diagnostics: Diagnostic[]): void {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.wasForgotten()) continue;
        const callee = call.getExpression();
        if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'objectContaining') continue;
        const arg = call.getArguments()[0];
        if (arg === undefined || !Node.isObjectLiteralExpression(arg)) continue;
        const schemaProp = arg.getProperties().find(prop => {
            const name = Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop) ? prop.getName() : undefined;
            return name !== undefined && SCHEMA_CONFIG_KEYS.has(name);
        });
        if (schemaProp === undefined) continue;
        diagnostics.push({
            ...actionRequired(
                sourceFile.getFilePath(),
                call,
                `Call-shape assertion pins a registration config schema — v2 configs carry wrapped schema objects ` +
                    `(z.object({ … })), so a raw-shape literal no longer matches. Assert with the wrapped schema or ` +
                    `expect.any(Object).`
            ),
            advisoryOnly: true
        });
    }
}

/**
 * Without a direct `McpServer` import the receiver's type is unknown, so the only
 * safe rewrites are calls whose receiver itself is named like an MCP server
 * (`server.tool(…)`, `harness.mcp.tool(…)`, `this.mockServer.prompt(…)`). The check
 * is strictly on the TERMINAL name of the receiver chain: a file that merely imports
 * an MCP type can contain shape-identical non-MCP calls — `cli.prompt('q', cb)`,
 * `app.resource('users', '/u', handler)`, and members hanging off a server such as
 * `this.server.cli.prompt(…)` — which must not be touched.
 */
function receiverLooksLikeMcpServer(receiver: Node): boolean {
    const unwrapped = unwrapReceiver(receiver);
    if (Node.isIdentifier(unwrapped)) return nameHasMcpServerWord(unwrapped.getText());
    if (Node.isPropertyAccessExpression(unwrapped)) return nameHasMcpServerWord(unwrapped.getName());
    return false;
}

/** Strip wrappers that do not change which object the method is called on. */
function unwrapReceiver(node: Node): Node {
    let current = node;
    for (;;) {
        if (
            Node.isParenthesizedExpression(current) ||
            Node.isNonNullExpression(current) ||
            Node.isAsExpression(current) ||
            Node.isSatisfiesExpression(current)
        ) {
            current = current.getExpression();
            continue;
        }
        return current;
    }
}

/** True when one of the identifier's camelCase / snake_case words is `mcp` or `server`. */
function nameHasMcpServerWord(name: string): boolean {
    return name
        .split(/[^a-zA-Z0-9]+|(?=[A-Z])/)
        .filter(Boolean)
        .some(word => /^(mcp|server)$/i.test(word));
}
