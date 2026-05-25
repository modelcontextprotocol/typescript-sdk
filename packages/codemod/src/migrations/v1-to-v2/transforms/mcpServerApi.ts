import type { CallExpression, SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { actionRequired, info } from '../../../utils/diagnostics.js';
import { isOriginalNameImportedFromMcp, resolveLocalImportName } from '../../../utils/importUtils.js';

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

        changesCount += migrateConstructorTaskOptions(sourceFile, diagnostics);

        return { changesCount, diagnostics };
    }
};

function isStringArg(node: Node): boolean {
    return Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateExpression(node);
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

    diagnostics.push(
        actionRequired(
            sourceFile.getFilePath(),
            call,
            `\`${schemaPropertyName}\` value is not an object literal — verify it is a z.object() schema. V2 requires a Zod schema, not a raw object.`
        )
    );
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

function migrateConstructorTaskOptions(sourceFile: SourceFile, diagnostics: Diagnostic[]): number {
    const localName = resolveLocalImportName(sourceFile, 'McpServer');
    if (!localName) return 0;

    let changes = 0;

    for (const node of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (node.wasForgotten()) continue;
        const expr = node.getExpression();
        if (!Node.isIdentifier(expr) || expr.getText() !== localName) continue;

        const args = node.getArguments();
        if (args.length < 2) continue;

        const optionsArg = args[1]!;
        if (!Node.isObjectLiteralExpression(optionsArg)) continue;

        // Check if any task options are present at the top level
        const propsToMove: string[] = [];
        for (const propName of TASK_OPTIONS) {
            if (optionsArg.getProperty(propName)) {
                propsToMove.push(propName);
            }
        }
        if (propsToMove.length === 0) continue;

        // Find the tasks object's position within the options text using AST,
        // then do all mutations via a single text replacement to avoid node invalidation.
        const capabilitiesProp = optionsArg.getProperty('capabilities');
        let tasksObjStart = -1;
        let tasksObjEnd = -1;
        const optionsStart = optionsArg.getStart();
        if (capabilitiesProp && Node.isPropertyAssignment(capabilitiesProp)) {
            const capInit = capabilitiesProp.getInitializer();
            if (capInit && Node.isObjectLiteralExpression(capInit)) {
                const tasksProp = capInit.getProperty('tasks');
                if (tasksProp && Node.isPropertyAssignment(tasksProp)) {
                    const tasksInit = tasksProp.getInitializer();
                    if (tasksInit && Node.isObjectLiteralExpression(tasksInit)) {
                        tasksObjStart = tasksInit.getStart() - optionsStart;
                        tasksObjEnd = tasksInit.getEnd() - optionsStart;
                    }
                }
            }
        }

        if (tasksObjStart === -1) {
            for (const propName of propsToMove) {
                diagnostics.push(
                    actionRequired(
                        sourceFile.getFilePath(),
                        node,
                        `Move '${propName}' from McpServer options into capabilities.tasks — v2 expects task runtime options inside the tasks capability.`
                    )
                );
            }
            continue;
        }

        // Single text replacement: remove top-level props and insert into tasks object.
        // Use AST nodes (already located via getProperty) to get brace-balanced text and
        // exact positions, avoiding regex truncation on values containing commas/braces.
        // Collect all properties first, then process in reverse position order so each
        // removal doesn't invalidate the positions of subsequent removals.
        let optionsText = optionsArg.getText();
        const argStart = optionsArg.getStart();
        const propsWithPositions: { text: string; start: number; end: number }[] = [];
        for (const propName of propsToMove) {
            const prop = optionsArg.getProperty(propName);
            if (!prop) continue;
            propsWithPositions.push({
                text: prop.getText(),
                start: prop.getStart() - argStart,
                end: prop.getEnd() - argStart
            });
        }
        const propTexts = propsWithPositions.map(p => p.text);

        // Remove in reverse position order so earlier positions remain valid
        const sortedProps = propsWithPositions.toSorted((a, b) => b.start - a.start);
        for (const { start, end } of sortedProps) {
            let remStart = start;
            let remEnd = end;
            // Consume trailing comma and whitespace
            const afterProp = optionsText.slice(remEnd);
            const trailingMatch = afterProp.match(/^\s*,?\s*/);
            if (trailingMatch) {
                remEnd += trailingMatch[0].length;
            }
            // Consume leading whitespace/newline
            const beforeProp = optionsText.slice(0, remStart);
            const leadingMatch = beforeProp.match(/[\n\r]?\s*$/);
            if (leadingMatch) {
                remStart -= leadingMatch[0].length;
            }
            optionsText = optionsText.slice(0, remStart) + optionsText.slice(remEnd);
            // Adjust tasks position if removal was before it
            if (remStart < tasksObjStart) {
                const shift = remEnd - remStart;
                tasksObjStart -= shift;
                tasksObjEnd -= shift;
            }
        }

        if (propTexts.length === 0) continue;

        // Insert into the tasks object (just before its closing brace)
        const tasksText = optionsText.slice(tasksObjStart, tasksObjEnd);
        const closingBrace = tasksText.lastIndexOf('}');
        const before = tasksText.slice(0, closingBrace).trimEnd();
        const sep = before.length > 1 ? ',\n' : '\n';
        const newTasksText = before + sep + propTexts.join(',\n') + '\n' + tasksText.slice(closingBrace);
        optionsText = optionsText.slice(0, tasksObjStart) + newTasksText + optionsText.slice(tasksObjEnd);

        // Clean up double/trailing commas
        optionsText = optionsText.replaceAll(/,(\s*,)/g, ',');
        optionsText = optionsText.replaceAll(/,(\s*})/g, '$1');

        optionsArg.replaceWithText(optionsText);
        changes += propTexts.length;
    }

    return changes;
}
