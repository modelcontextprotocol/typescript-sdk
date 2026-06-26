import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

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
            if (methodName !== 'setRequestHandler' && methodName !== 'setNotificationHandler') {
                continue;
            }

            const args = call.getArguments();
            if (args.length < 2) continue;

            const firstArg = args[0]!;
            if (!Node.isIdentifier(firstArg)) continue;

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

            const methodString = ALL_SCHEMA_TO_METHOD[originalName];
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

            if (!isImportedFromMcp(sourceFile, schemaName)) continue;

            firstArg.replaceWithText(`'${methodString}'`);
            changesCount++;

            removeUnusedImport(sourceFile, schemaName, true);
        }

        return { changesCount, diagnostics };
    }
};
