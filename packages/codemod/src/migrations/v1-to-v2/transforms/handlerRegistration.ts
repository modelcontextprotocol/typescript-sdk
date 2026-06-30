import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind, VariableDeclarationKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types';
import { actionRequired } from '../../../utils/diagnostics';
import { hasMcpImports, isImportedFromMcp, removeUnusedImport, resolveOriginalImportName } from '../../../utils/importUtils';
import { NOTIFICATION_SCHEMA_TO_METHOD, REMOVED_TASK_SCHEMAS, SCHEMA_TO_METHOD } from '../mappings/schemaToMethodMap';

const ALL_SCHEMA_TO_METHOD: Record<string, string> = {
    ...SCHEMA_TO_METHOD,
    ...NOTIFICATION_SCHEMA_TO_METHOD
};

export const handlerRegistrationTransform: Transform = {
    name: 'Handler registration migration',
    id: 'handlers',
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
            if (methodName === 'removeRequestHandler' || methodName === 'removeNotificationHandler') {
                const arg0 = call.getArguments()[0];
                if (
                    arg0 === undefined ||
                    Node.isStringLiteral(arg0) ||
                    Node.isNoSubstitutionTemplateLiteral(arg0) ||
                    Node.isTemplateExpression(arg0)
                )
                    continue;
                const shapeMatch = arg0.getText().match(/^([A-Za-z_$][\w$]*)\.shape\.method\.value$/);
                const shapeBase = shapeMatch ? (resolveOriginalImportName(sourceFile, shapeMatch[1]!) ?? shapeMatch[1]!) : undefined;
                const shapeMethod = shapeBase === undefined ? undefined : ALL_SCHEMA_TO_METHOD[shapeBase];
                if (shapeMatch && shapeMethod !== undefined && isImportedFromMcp(sourceFile, shapeMatch[1]!)) {
                    arg0.replaceWithText(`'${shapeMethod}'`);
                    changesCount++;
                    removeUnusedImport(sourceFile, shapeMatch[1]!, true);
                } else {
                    diagnostics.push({
                        ...actionRequired(
                            sourceFile.getFilePath(),
                            call,
                            `${methodName} takes the method string in v2 — replace the schema-derived argument with the ` +
                                `literal method name (no change needed if this already passes a string).`
                        ),
                        advisoryOnly: true
                    });
                }
                continue;
            }
            if (methodName !== 'setRequestHandler' && methodName !== 'setNotificationHandler') {
                continue;
            }

            const args = call.getArguments();
            if (args.length < 2) continue;

            const firstArg = args[0]!;
            if (!Node.isIdentifier(firstArg)) {
                // A string first argument is already the v2 form; any other expression
                // (inline schema object, property access, `X.shape.method.value`) is a
                // v1 registration the rename path cannot resolve — mark it instead of
                // skipping silently.
                if (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg) || Node.isTemplateExpression(firstArg))
                    continue;
                const shapeMatch = firstArg.getText().match(/^([A-Za-z_$][\w$]*)\.shape\.method\.value$/);
                const shapeBase = shapeMatch ? (resolveOriginalImportName(sourceFile, shapeMatch[1]!) ?? shapeMatch[1]!) : undefined;
                const shapeMethod = shapeBase === undefined ? undefined : ALL_SCHEMA_TO_METHOD[shapeBase];
                if (shapeMatch && shapeMethod !== undefined && isImportedFromMcp(sourceFile, shapeMatch[1]!)) {
                    firstArg.replaceWithText(`'${shapeMethod}'`);
                    changesCount++;
                    removeUnusedImport(sourceFile, shapeMatch[1]!, true);
                } else {
                    diagnostics.push({
                        ...actionRequired(
                            sourceFile.getFilePath(),
                            call,
                            `${methodName} with a non-string first argument: v2 takes a method string — use the typed ` +
                                `two-argument spec form, or the three-argument custom form ` +
                                `(${methodName}('method/name', { params, result? }, handler)). No change is needed if the ` +
                                `argument already holds a method string.`
                        ),
                        advisoryOnly: true
                    });
                }
                continue;
            }

            const schemaName = firstArg.getText();
            const originalName = resolveOriginalImportName(sourceFile, schemaName) ?? schemaName;

            if (REMOVED_TASK_SCHEMAS.has(originalName) && isImportedFromMcp(sourceFile, schemaName)) {
                diagnostics.push(
                    actionRequired(
                        sourceFile.getFilePath(),
                        call,
                        `Task handler registration: ${methodName}(${schemaName}, ...). ` +
                            `The experimental tasks feature was removed in v2 (SEP-2663); the tasks/* method strings ` +
                            `are not part of the typed RequestMethod surface. Remove this registration. ` +
                            `See docs/migration/upgrade-to-v2.md#experimental-tasks-interception-removed.`
                    )
                );
                continue;
            }

            let methodString = ALL_SCHEMA_TO_METHOD[originalName];
            if (methodString === undefined) {
                // `const S = ListToolsRequestSchema; setRequestHandler(S, …)` — resolve
                // one same-file variable hop before declaring the schema custom. Only an
                // unambiguous binding qualifies: exactly one const declaration of the
                // name anywhere in the file, so shadowed or reassigned locals keep the
                // custom-handler marker instead of being silently rewritten.
                const declsOfName = sourceFile
                    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
                    .filter(decl => decl.getName() === schemaName);
                const localDecl =
                    declsOfName.length === 1 &&
                    declsOfName[0]!.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const
                        ? declsOfName[0]
                        : undefined;
                const localInit = localDecl?.getInitializer();
                if (localInit !== undefined && Node.isIdentifier(localInit)) {
                    const initName = localInit.getText();
                    const initOriginal = resolveOriginalImportName(sourceFile, initName) ?? initName;
                    if (REMOVED_TASK_SCHEMAS.has(initOriginal) && isImportedFromMcp(sourceFile, initName)) {
                        diagnostics.push(
                            actionRequired(
                                sourceFile.getFilePath(),
                                call,
                                `Task handler registration: ${methodName}(${schemaName}, ...). ` +
                                    `The experimental tasks feature was removed in v2 (SEP-2663); the tasks/* method strings ` +
                                    `are not part of the typed RequestMethod surface. Remove this registration. ` +
                                    `See docs/migration/upgrade-to-v2.md#experimental-tasks-interception-removed.`
                            )
                        );
                        continue;
                    }
                    const viaLocal = ALL_SCHEMA_TO_METHOD[initOriginal];
                    if (viaLocal !== undefined && isImportedFromMcp(sourceFile, initName)) {
                        methodString = viaLocal;
                    }
                }
            }
            if (!methodString) {
                diagnostics.push(
                    actionRequired(
                        sourceFile.getFilePath(),
                        call,
                        `Custom method handler: ${methodName}(${schemaName}, ...). ` +
                            `In v2, use the 3-arg form: ${methodName}('method/name', { params, result? }, handler). ` +
                            `See docs/migration/upgrade-to-v2.md for details.`
                    )
                );
                continue;
            }

            const viaLocalVariable = ALL_SCHEMA_TO_METHOD[originalName] === undefined;
            if (!viaLocalVariable && !isImportedFromMcp(sourceFile, schemaName)) continue;

            firstArg.replaceWithText(`'${methodString}'`);
            changesCount++;

            removeUnusedImport(sourceFile, schemaName, true);
        }

        return { changesCount, diagnostics };
    }
};
