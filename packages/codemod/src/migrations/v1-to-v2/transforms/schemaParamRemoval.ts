import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Transform, TransformContext, TransformResult } from '../../../types.js';
import { isImportedFromMcp, removeUnusedImport } from '../../../utils/importUtils.js';

const TARGET_METHODS = new Set(['request', 'callTool', 'send']);

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
            if (!isSchemaReference(secondArg)) continue;

            const schemaName = secondArg.getText();
            if (!isImportedFromMcp(sourceFile, schemaName)) continue;

            call.removeArgument(1);
            changesCount++;

            removeUnusedImport(sourceFile, schemaName);
        }

        return { changesCount, diagnostics: [] };
    }
};

function isSchemaReference(node: Node): boolean {
    if (!Node.isIdentifier(node)) return false;
    const text = node.getText();
    return text.endsWith('Schema');
}
