import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { warning } from '../../../utils/diagnostics.js';
import { hasMcpImports } from '../../../utils/importUtils.js';
import { CONTEXT_PROPERTY_MAP, CTX_PARAM_NAME, EXTRA_PARAM_NAME } from '../mappings/contextPropertyMap.js';

const HANDLER_METHODS = new Set(['setRequestHandler', 'setNotificationHandler']);

const REGISTER_METHODS = new Set(['registerTool', 'registerPrompt', 'registerResource', 'tool', 'prompt', 'resource']);

export const contextTypesTransform: Transform = {
    name: 'Context type rewrites',
    id: 'context',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        if (!hasMcpImports(sourceFile)) {
            return { changesCount: 0, diagnostics: [] };
        }

        let changesCount = 0;
        const diagnostics: Diagnostic[] = [];

        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

        for (const call of calls) {
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
            } else if (isRegister && args.length >= 3) {
                callbackArg = args.at(-1);
            }

            if (!callbackArg) continue;
            if (!Node.isArrowFunction(callbackArg) && !Node.isFunctionExpression(callbackArg)) continue;

            const params = callbackArg.getParameters();
            if (params.length < 2) continue;

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
                continue;
            }
            const paramName = extraParam.getName();
            if (paramName !== EXTRA_PARAM_NAME) continue;

            const body = callbackArg.getBody();

            if (body) {
                let ctxAlreadyInScope = false;
                body.forEachDescendant(node => {
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
                    continue;
                }
            }

            extraParam.rename(CTX_PARAM_NAME);
            changesCount++;

            if (!body) continue;

            body.forEachDescendant(node => {
                if (!Node.isPropertyAccessExpression(node)) return;

                const fullText = node.getText();
                for (const mapping of CONTEXT_PROPERTY_MAP) {
                    if (mapping.from === mapping.to) continue;

                    const oldPattern = CTX_PARAM_NAME + mapping.from;
                    const oldPatternOptional = CTX_PARAM_NAME + '?' + mapping.from;
                    const matchedPattern = fullText.startsWith(oldPattern)
                        ? oldPattern
                        : fullText.startsWith(oldPatternOptional)
                          ? oldPatternOptional
                          : null;
                    if (matchedPattern) {
                        const nextChar = fullText[matchedPattern.length];
                        if (nextChar !== undefined && /[a-zA-Z0-9_$]/.test(nextChar)) continue;

                        const newText = fullText.replace(matchedPattern, CTX_PARAM_NAME + mapping.to);
                        node.replaceWithText(newText);
                        changesCount++;
                        return;
                    }
                }
            });

            body.forEachDescendant(node => {
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

        return { changesCount, diagnostics };
    }
};
