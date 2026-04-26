import type { CallExpression, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { info, warning } from '../../../utils/diagnostics.js';
import { isExportedFromMcp } from '../../../utils/importUtils.js';

export const mcpServerApiTransform: Transform = {
    name: 'McpServer API migration',
    id: 'mcpserver-api',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        const diagnostics: Diagnostic[] = [];
        let changesCount = 0;

        if (!isExportedFromMcp(sourceFile, 'McpServer')) {
            return { changesCount: 0, diagnostics: [] };
        }

        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

        const toolCalls: CallExpression[] = [];
        const promptCalls: CallExpression[] = [];
        const resourceCalls: CallExpression[] = [];

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
            }
        }

        for (const call of toolCalls) {
            const result = migrateToolCall(call, sourceFile, diagnostics);
            if (result) {
                changesCount++;
            } else {
                diagnostics.push(
                    warning(
                        sourceFile.getFilePath(),
                        call.getStartLineNumber(),
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
                    warning(
                        sourceFile.getFilePath(),
                        call.getStartLineNumber(),
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
                    warning(
                        sourceFile.getFilePath(),
                        call.getStartLineNumber(),
                        'Could not automatically migrate .resource() call. Manual migration required.'
                    )
                );
            }
        }

        return { changesCount, diagnostics };
    }
};

function isStringArg(node: Node): boolean {
    return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node);
}

function wrapWithZObject(schemaText: string): string {
    if (schemaText.startsWith('z.object(')) return schemaText;
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
    }
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
            // server.tool(name, description, schema, callback)
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
    if (schema) configParts.push(`inputSchema: ${schema}`);
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
