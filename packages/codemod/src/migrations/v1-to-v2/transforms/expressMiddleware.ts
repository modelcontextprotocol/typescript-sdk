import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformContext, TransformResult } from '../../../types.js';
import { info } from '../../../utils/diagnostics.js';
import { isOriginalNameImportedFromMcp, resolveLocalImportName } from '../../../utils/importUtils.js';

export const expressMiddlewareTransform: Transform = {
    name: 'Express middleware signature migration',
    id: 'express-middleware',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        if (!isOriginalNameImportedFromMcp(sourceFile, 'hostHeaderValidation')) {
            return { changesCount: 0, diagnostics: [] };
        }

        const diagnostics: Diagnostic[] = [];
        let changesCount = 0;

        const localName = resolveLocalImportName(sourceFile, 'hostHeaderValidation') ?? 'hostHeaderValidation';
        changesCount += rewriteHostHeaderValidation(sourceFile, localName, diagnostics);

        return { changesCount, diagnostics };
    }
};

function rewriteHostHeaderValidation(sourceFile: SourceFile, targetName: string, diagnostics: Diagnostic[]): number {
    let changesCount = 0;

    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of calls) {
        const expr = call.getExpression();
        if (!Node.isIdentifier(expr) || expr.getText() !== targetName) continue;

        const args = call.getArguments();
        if (args.length !== 1) continue;

        const firstArg = args[0]!;
        if (!Node.isObjectLiteralExpression(firstArg)) continue;

        const allowedHostsProp = firstArg.getProperty('allowedHosts');
        if (!allowedHostsProp || !Node.isPropertyAssignment(allowedHostsProp)) continue;

        const initializer = allowedHostsProp.getInitializer();
        if (!initializer) continue;

        const arrayText = initializer.getText();
        firstArg.replaceWithText(arrayText);
        changesCount++;

        diagnostics.push(
            info(
                sourceFile.getFilePath(),
                call.getStartLineNumber(),
                'hostHeaderValidation({ allowedHosts: [...] }) simplified to hostHeaderValidation([...]). Verify the migration.'
            )
        );
    }

    return changesCount;
}
