import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { info, warning } from '../../../utils/diagnostics.js';
import { hasMcpImports } from '../../../utils/importUtils.js';
import { CONTEXT_PROPERTY_MAP, CTX_PARAM_NAME, EXTRA_PARAM_NAME } from '../mappings/contextPropertyMap.js';

const HANDLER_METHODS = new Set(['setRequestHandler', 'setNotificationHandler']);

const REGISTER_METHODS = new Set(['registerTool', 'registerPrompt', 'registerResource', 'registerToolTask', 'tool', 'prompt', 'resource']);

/**
 * Rewrite context property accesses and typeof type queries within a callback body.
 * Returns the number of changes made.
 */
/**
 * Attempt to rename the second parameter of a callback from 'extra' to 'ctx'
 * and rewrite context property accesses in its body.
 * Returns the number of changes made, or -1 if skipped.
 */
function processCallback(
    callbackNode: Node,
    sourceFile: SourceFile,
    diagnostics: Diagnostic[],
    methodName: string,
    callLine: number
): number {
    if (!Node.isArrowFunction(callbackNode) && !Node.isFunctionExpression(callbackNode) && !Node.isMethodDeclaration(callbackNode))
        return -1;

    const params = callbackNode.getParameters();
    if (params.length < 2) return -1;

    const extraParam = params[1]!;
    const paramNameNode = extraParam.getNameNode();
    if (Node.isObjectBindingPattern(paramNameNode)) {
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                extraParam.getStartLineNumber(),
                `Destructuring of context parameter in signature: "${paramNameNode.getText()}". ` +
                    'Properties have been reorganized in v2 (e.g., signal is now ctx.mcpReq.signal). Manual refactoring required.'
            )
        );
        return -1;
    }
    const paramName = extraParam.getName();
    if (paramName !== EXTRA_PARAM_NAME) return -1;

    const body = callbackNode.getBody();

    const otherParams = callbackNode.getParameters().filter(p => p !== extraParam);
    if (otherParams.some(p => p.getName() === CTX_PARAM_NAME)) {
        diagnostics.push(
            warning(
                sourceFile.getFilePath(),
                extraParam.getStartLineNumber(),
                `Cannot rename '${EXTRA_PARAM_NAME}' to '${CTX_PARAM_NAME}': another parameter is already named '${CTX_PARAM_NAME}'. Manual migration required.`
            )
        );
        return -1;
    }

    if (body) {
        let ctxAlreadyInScope = false;
        body.forEachDescendant((node, traversal) => {
            if (
                (Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node)) &&
                node.getParameters().some(p => p.getName() === CTX_PARAM_NAME)
            ) {
                traversal.skip();
                return;
            }
            if (Node.isIdentifier(node) && node.getText() === CTX_PARAM_NAME) {
                ctxAlreadyInScope = true;
            }
        });
        if (ctxAlreadyInScope) {
            diagnostics.push(
                warning(
                    sourceFile.getFilePath(),
                    extraParam.getStartLineNumber(),
                    `Cannot rename '${EXTRA_PARAM_NAME}' to '${CTX_PARAM_NAME}': '${CTX_PARAM_NAME}' is already referenced in this scope. Manual migration required.`
                )
            );
            return -1;
        }
    }

    // Rename param declaration and all body references in one text-based pass.
    // We avoid extraParam.rename() because it invalidates descendant node references,
    // causing "node was removed or forgotten" errors in subsequent AST traversals.
    const bodyText = body ? body.getText() : '';
    const paramDecl = extraParam.getNameNode();
    paramDecl.replaceWithText(CTX_PARAM_NAME);

    if (body) {
        let newBodyText = bodyText.replaceAll(new RegExp(String.raw`\b${EXTRA_PARAM_NAME}\b`, 'g'), CTX_PARAM_NAME);
        // Sort mappings longest-first so longer property names match before shorter prefixes
        const sortedMappings = [...CONTEXT_PROPERTY_MAP].filter(m => m.from !== m.to).toSorted((a, b) => b.from.length - a.from.length);
        for (const mapping of sortedMappings) {
            const escaped = (CTX_PARAM_NAME + mapping.from).replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
            const re = new RegExp(escaped + String.raw`(?![a-zA-Z0-9_$])`, 'g');
            newBodyText = newBodyText.replaceAll(re, CTX_PARAM_NAME + mapping.to);
        }
        // Also handle optional chaining variants (e.g., ctx?.signal → ctx.mcpReq.signal)
        for (const mapping of sortedMappings) {
            const escaped = (CTX_PARAM_NAME + '?' + mapping.from).replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
            const re = new RegExp(escaped + String.raw`(?![a-zA-Z0-9_$])`, 'g');
            newBodyText = newBodyText.replaceAll(re, CTX_PARAM_NAME + mapping.to);
        }
        if (newBodyText !== bodyText) {
            body.replaceWithText(newBodyText);
        }
    }

    const changes = 1;

    if (['tool', 'prompt', 'resource'].includes(methodName)) {
        diagnostics.push(
            info(
                sourceFile.getFilePath(),
                callLine,
                `Renamed 'extra' to 'ctx' in .${methodName}() callback. If this is not an McpServer method, revert this change.`
            )
        );
    }

    // Warn on destructuring of ctx in body (after text replacement)
    const freshBody = callbackNode.getBody();
    if (freshBody) {
        freshBody.forEachDescendant(node => {
            if (!Node.isVariableDeclaration(node)) return;
            const initializer = node.getInitializer();
            if (!initializer || !Node.isIdentifier(initializer) || initializer.getText() !== CTX_PARAM_NAME) return;
            const nameNode = node.getNameNode();
            if (!Node.isObjectBindingPattern(nameNode)) return;
            diagnostics.push(
                warning(
                    sourceFile.getFilePath(),
                    node.getStartLineNumber(),
                    `Destructuring of context parameter detected: "const ${nameNode.getText()} = ${CTX_PARAM_NAME}". ` +
                        'Properties have been reorganized in v2 (e.g., signal is now ctx.mcpReq.signal). Manual refactoring required.'
                )
            );
        });
    }

    return changes;
}

export const contextTypesTransform: Transform = {
    name: 'Context type rewrites',
    id: 'context',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        if (!hasMcpImports(sourceFile)) {
            return { changesCount: 0, diagnostics: [] };
        }

        let changesCount = 0;
        const diagnostics: Diagnostic[] = [];

        // Process one callback at a time, re-querying the AST after each.
        // processCallback uses body.replaceWithText() which invalidates sibling nodes,
        // so we cannot iterate a pre-collected list of calls.
        let madeProgress = true;
        const processed = new Set<number>();
        while (madeProgress) {
            madeProgress = false;
            const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

            for (const call of calls) {
                const callStart = call.getStart();
                if (processed.has(callStart)) continue;

                const expr = call.getExpression();
                if (!Node.isPropertyAccessExpression(expr)) continue;

                const methodName = expr.getName();
                const isHandler = HANDLER_METHODS.has(methodName);
                const isRegister = REGISTER_METHODS.has(methodName);
                if (!isHandler && !isRegister) continue;

                const args = call.getArguments();

                let callbackArg: Node | undefined;
                if (isHandler && args.length >= 2) {
                    callbackArg = args[1];
                } else if (isRegister && args.length >= 2) {
                    callbackArg = args.at(-1);
                }

                if (!callbackArg) continue;

                // Handle ObjectLiteralExpression for registerToolTask-style callbacks
                if (Node.isObjectLiteralExpression(callbackArg)) {
                    for (const prop of callbackArg.getProperties()) {
                        let callbackNode: Node | undefined;
                        if (Node.isPropertyAssignment(prop)) {
                            callbackNode = prop.getInitializer();
                        } else if (Node.isMethodDeclaration(prop)) {
                            callbackNode = prop;
                        }
                        if (!callbackNode) continue;

                        const result = processCallback(callbackNode, sourceFile, diagnostics, methodName, call.getStartLineNumber());
                        if (result > 0) {
                            changesCount += result;
                            madeProgress = true;
                        }
                    }
                    processed.add(callStart);
                    if (madeProgress) break;
                    continue;
                }

                // Handle direct ArrowFunction / FunctionExpression callbacks
                const result = processCallback(callbackArg, sourceFile, diagnostics, methodName, call.getStartLineNumber());
                processed.add(callStart);
                if (result > 0) {
                    changesCount += result;
                    madeProgress = true;
                    break;
                }
            }
        }

        return { changesCount, diagnostics };
    }
};
