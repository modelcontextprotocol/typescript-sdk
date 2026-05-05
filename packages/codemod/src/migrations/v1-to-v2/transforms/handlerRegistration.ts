import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { warning } from '../../../utils/diagnostics.js';
import { isImportedFromMcp, removeUnusedImport, resolveOriginalImportName } from '../../../utils/importUtils.js';
import { NOTIFICATION_SCHEMA_TO_METHOD, SCHEMA_TO_METHOD } from '../mappings/schemaToMethodMap.js';

const ALL_SCHEMA_TO_METHOD: Record<string, string> = {
    ...SCHEMA_TO_METHOD,
    ...NOTIFICATION_SCHEMA_TO_METHOD
};

export const handlerRegistrationTransform: Transform = {
    name: 'Handler registration migration',
    id: 'handlers',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
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
            const methodString = ALL_SCHEMA_TO_METHOD[originalName];
            if (!methodString) {
                diagnostics.push(
                    warning(
                        sourceFile.getFilePath(),
                        call.getStartLineNumber(),
                        `Custom method handler: ${methodName}(${schemaName}, ...). ` +
                            `In v2, use the 3-arg form: ${methodName}('method/name', { params, result? }, handler). ` +
                            `See migration.md for details.`
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
