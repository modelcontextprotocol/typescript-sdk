import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Transform, TransformContext, TransformResult } from '../../../types.js';
import { isImportedFromMcp, removeUnusedImport, resolveOriginalImportName } from '../../../utils/importUtils.js';

const TARGET_METHODS = new Set(['request', 'callTool']);

export const schemaParamRemovalTransform: Transform = {
    name: 'Schema parameter removal',
    id: 'schema-params',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        let changesCount = 0;

        const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

        for (const call of calls) {
            const expr = call.getExpression();
            if (!Node.isPropertyAccessExpression(expr)) continue;

            const methodName = expr.getName();
            if (!TARGET_METHODS.has(methodName)) continue;

            const args = call.getArguments();
            if (args.length < 2) continue;

            const secondArg = args[1]!;
            if (!Node.isIdentifier(secondArg)) continue;

            // `request(req, undefined, options)` / `callTool(params, undefined, options)`: v1 passed an
            // explicit `undefined` result schema before the trailing options argument. v2 removed the
            // schema parameter for spec methods, so the literal `undefined` leaves the call with one
            // argument too many (TS2554). Drop it only when a third argument follows — a 2-arg
            // `callTool(params, undefined)` already type-checks, since `undefined` is a valid options arg.
            if (secondArg.getText() === 'undefined') {
                if (args.length >= 3) {
                    call.removeArgument(1);
                    changesCount++;
                }
                continue;
            }

            const schemaName = secondArg.getText();
            const originalName = resolveOriginalImportName(sourceFile, schemaName) ?? schemaName;
            if (!originalName.endsWith('Schema')) continue;
            if (!isImportedFromMcp(sourceFile, schemaName)) continue;

            call.removeArgument(1);
            changesCount++;

            removeUnusedImport(sourceFile, schemaName, true);
        }

        return { changesCount, diagnostics: [] };
    }
};
