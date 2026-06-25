import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { isKeyPositionIdentifier } from '../../../utils/astUtils';
import { actionRequired, info } from '../../../utils/diagnostics';
import { hasMcpImports } from '../../../utils/importUtils';
import { CONTEXT_PROPERTY_MAP, CTX_PARAM_NAME, EXTRA_PARAM_NAME } from '../mappings/contextPropertyMap';

const HANDLER_METHODS = new Set(['setRequestHandler', 'setNotificationHandler']);

const REGISTER_METHODS = new Set(['registerTool', 'registerPrompt', 'registerResource', 'tool', 'prompt', 'resource']);

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
            actionRequired(
                sourceFile.getFilePath(),
                extraParam,
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
            actionRequired(
                sourceFile.getFilePath(),
                extraParam,
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
                actionRequired(
                    sourceFile.getFilePath(),
                    extraParam,
                    `Cannot rename '${EXTRA_PARAM_NAME}' to '${CTX_PARAM_NAME}': '${CTX_PARAM_NAME}' is already referenced in this scope. Manual migration required.`
                )
            );
            return -1;
        }
    }

    // Rename param declaration and rewrite body references using AST traversal.
    // We walk Identifier nodes to avoid corrupting string literals, comments, and
    // unrelated property names (e.g., meta.extra) that regex-based replacement would hit.
    const paramDecl = extraParam.getNameNode();
    paramDecl.replaceWithText(CTX_PARAM_NAME);

    if (body) {
        const sortedMappings = [...CONTEXT_PROPERTY_MAP].filter(m => m.from !== m.to).toSorted((a, b) => b.from.length - a.from.length);

        // Collect identifiers that are actual references to the `extra` parameter
        const identifiers: import('ts-morph').Node[] = [];
        body.forEachDescendant(node => {
            if (!Node.isIdentifier(node) || node.getText() !== EXTRA_PARAM_NAME) return;
            const parent = node.getParent();
            if (parent && isKeyPositionIdentifier(node)) return;
            identifiers.push(node);
        });

        // Build replacements: apply property mappings for PropertyAccess/QualifiedName, plain rename otherwise
        const replacements: { node: import('ts-morph').Node; newText: string }[] = [];
        for (const id of identifiers) {
            const parent = id.getParent();
            // Value-position property access: extra.signal → ctx.mcpReq.signal
            if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === id) {
                const propName = '.' + parent.getName();
                const mapping = sortedMappings.find(m => m.from === propName);
                if (mapping) {
                    replacements.push({ node: parent, newText: CTX_PARAM_NAME + mapping.to });
                    continue;
                }
            }
            // Type-position qualified name: typeof extra.signal → typeof ctx.mcpReq.signal
            if (parent && parent.getKind() === SyntaxKind.QualifiedName && parent.getChildAtIndex(0) === id) {
                const right = parent.getChildAtIndex(2);
                if (right) {
                    const propName = '.' + right.getText();
                    const mapping = sortedMappings.find(m => m.from === propName);
                    if (mapping) {
                        replacements.push({ node: parent, newText: CTX_PARAM_NAME + mapping.to });
                        continue;
                    }
                }
            }
            // Shorthand property assignment: { extra } → { extra: ctx }
            if (parent && Node.isShorthandPropertyAssignment(parent)) {
                replacements.push({ node: parent, newText: `${EXTRA_PARAM_NAME}: ${CTX_PARAM_NAME}` });
                continue;
            }
            replacements.push({ node: id, newText: CTX_PARAM_NAME });
        }

        // Apply in reverse position order to avoid node invalidation
        const sorted = replacements.toSorted((a, b) => b.node.getStart() - a.node.getStart());
        for (const { node, newText } of sorted) {
            node.replaceWithText(newText);
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
                actionRequired(
                    sourceFile.getFilePath(),
                    node,
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

                // Handle ObjectLiteralExpression callback containers (handler maps)
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
