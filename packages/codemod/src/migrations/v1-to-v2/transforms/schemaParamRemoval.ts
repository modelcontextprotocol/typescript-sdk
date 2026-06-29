import type { SourceFile } from 'ts-morph';
import { Node, SyntaxKind } from 'ts-morph';

import type { Transform, TransformContext, TransformResult } from '../../../types';
import { hasMcpImports, isImportedFromMcp, removeUnusedImport, resolveOriginalImportName } from '../../../utils/importUtils';

const TARGET_METHODS = new Set(['request', 'callTool']);

// `request()` keeps its result-schema parameter in v2 (custom methods, passthrough
// forwarding); only calls whose method the codemod can PROVE is a literal string may
// safely lose it. A dynamic method — `request({ method, params }, schema)` in a
// proxy/forwarder — must keep the schema: schema-less v2 `request()` enforces the
// spec result schema for known methods and resolves `undefined` for unknown ones.
function hasLiteralMethod(arg: Node): boolean {
    if (!Node.isObjectLiteralExpression(arg)) return false;
    const prop = arg.getProperty('method');
    if (!prop || !Node.isPropertyAssignment(prop)) return false;
    // A spread after the `method` property can override it at runtime — not provably literal.
    const props = arg.getProperties();
    const spreadAfterMethod = props.slice(props.indexOf(prop) + 1).some(p => Node.isSpreadAssignment(p));
    if (spreadAfterMethod) return false;
    let initializer = prop.getInitializer();
    // Unwrap `'tools/call' as const` / `satisfies` / parenthesized forms.
    while (
        initializer !== undefined &&
        (Node.isAsExpression(initializer) || Node.isSatisfiesExpression(initializer) || Node.isParenthesizedExpression(initializer))
    ) {
        initializer = initializer.getExpression();
    }
    return initializer !== undefined && (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer));
}

export const schemaParamRemovalTransform: Transform = {
    name: 'Schema parameter removal',
    id: 'schema-params',
    apply(sourceFile: SourceFile, _context: TransformContext): TransformResult {
        let changesCount = 0;

        // `request`/`callTool` are common method names on non-MCP receivers too. The schema-identifier
        // path guards per-symbol via `isImportedFromMcp`; the `undefined` path has no symbol to check, so
        // gate it on a file-level MCP signal to avoid rewriting unrelated calls.
        const fileHasMcpImports = hasMcpImports(sourceFile);

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
                if (fileHasMcpImports && args.length >= 3) {
                    call.removeArgument(1);
                    changesCount++;
                }
                continue;
            }

            const schemaName = secondArg.getText();
            const originalName = resolveOriginalImportName(sourceFile, schemaName) ?? schemaName;
            if (!originalName.endsWith('Schema')) continue;
            if (!isImportedFromMcp(sourceFile, schemaName)) continue;

            // v2 `callTool()` has no schema parameter at all, so the argument always goes.
            // v2 `request()` still accepts one — only drop it when the method is a literal
            // (see hasLiteralMethod) and the schema is method-specific: the generic
            // `ResultSchema` is the v1 passthrough idiom, and dropping it would silently
            // switch the call from passthrough to spec-schema enforcement.
            if (methodName === 'request') {
                if (!hasLiteralMethod(args[0]!)) continue;
                if (originalName === 'ResultSchema') continue;
            }

            call.removeArgument(1);
            changesCount++;

            removeUnusedImport(sourceFile, schemaName, true);
        }

        return { changesCount, diagnostics: [] };
    }
};
