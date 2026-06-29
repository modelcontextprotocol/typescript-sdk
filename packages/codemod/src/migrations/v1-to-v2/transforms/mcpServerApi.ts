import type { CallExpression, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { actionRequired, info } from '../../../utils/diagnostics';
import { isOriginalNameImportedFromMcp, resolveLocalImportName } from '../../../utils/importUtils';

export const mcpServerApiTransform: Transform = {
    name: 'McpServer API migration',
    id: 'mcpserver-api',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        let changesCount = 0;

        if (!isOriginalNameImportedFromMcp(sourceFile, 'McpServer')) {
            return { changesCount: 0, diagnostics: [] };
        }

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

            switch (methodName) {
                case 'tool': {
                    toolCalls.push(call);
                    break;
                }
                case 'prompt': {
                    promptCalls.push(call);
                    break;
                }
                case 'resource': {
                    resourceCalls.push(call);
                    break;
                }
                case 'registerTool': {
                    registerToolCalls.push(call);
                    break;
                }
                case 'registerPrompt': {
                    registerPromptCalls.push(call);
                    break;
                }
                case 'registerResource': {
                    registerResourceCalls.push(call);
                    break;
                }
            }
        }

        for (const call of toolCalls) {
            const result = migrateToolCall(call, sourceFile, diagnostics);
            if (result) {
                changesCount++;
            } else {
                diagnostics.push(
                    actionRequired(
                        sourceFile.getFilePath(),
                        call,
                        'Could not automatically migrate .tool() call. Manual migration required.'
                    )
                );
            }
        }

        for (const call of promptCalls) {
            const result = migratePromptCall(call, sourceFile, diagnostics);
            if (result) {
                changesCount++;
            } else {
                diagnostics.push(
                    actionRequired(
                        sourceFile.getFilePath(),
                        call,
                        'Could not automatically migrate .prompt() call. Manual migration required.'
                    )
                );
            }
        }

        for (const call of resourceCalls) {
            const result = migrateResourceCall(call, sourceFile);
            if (result) {
                changesCount++;
            } else {
                diagnostics.push(
                    actionRequired(
                        sourceFile.getFilePath(),
                        call,
                        'Could not automatically migrate .resource() call. Manual migration required.'
                    )
                );
            }
        }

        for (const call of registerToolCalls) {
            if (wrapSchemaInConfig(call, 'inputSchema', sourceFile, diagnostics)) {
                changesCount++;
            }
            if (wrapSchemaInConfig(call, 'outputSchema', sourceFile, diagnostics)) {
                changesCount++;
            }
        }

        for (const call of registerPromptCalls) {
            if (wrapSchemaInConfig(call, 'argsSchema', sourceFile, diagnostics)) {
                changesCount++;
            }
        }

        for (const call of registerResourceCalls) {
            if (wrapSchemaInConfig(call, 'uriSchema', sourceFile, diagnostics)) {
                changesCount++;
            }
        }

        flagRemovedTaskOptions(sourceFile, diagnostics);

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
        diagnostics.push(
            info(
                sourceFile.getFilePath(),
                call.getStartLineNumber(),
                'Raw object literal wrapped with z.object(). Verify that zod (z) is imported in this file.'
            )
        );
    } else if (!isZodObjectCall(node)) {
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                call,
                'Schema argument is not an object literal — verify it is a z.object() schema. V2 requires a Zod schema, not a raw object.'
            )
        );
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
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                call,
                `Shorthand \`{ ${schemaPropertyName} }\` in config: verify the value is a z.object() schema, not a raw object. V2 requires a Zod schema.`
            )
        );
        return false;
    }

    if (!Node.isPropertyAssignment(schemaProp)) return false;

    const initializer = schemaProp.getInitializer();
    if (!initializer) return false;

    if (Node.isObjectLiteralExpression(initializer)) {
        const wrapped = wrapWithZObject(initializer.getText());
        initializer.replaceWithText(wrapped);
        diagnostics.push(
            info(
                sourceFile.getFilePath(),
                call.getStartLineNumber(),
                `Raw object literal in ${schemaPropertyName} wrapped with z.object(). Verify that zod (z) is imported in this file.`
            )
        );
        return true;
    }

    if (!isZodObjectCall(initializer)) {
        diagnostics.push(
            actionRequired(
                sourceFile.getFilePath(),
                call,
                `\`${schemaPropertyName}\` value is not an object literal — verify it is a z.object() schema. V2 requires a Zod schema, not a raw object.`
            )
        );
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
