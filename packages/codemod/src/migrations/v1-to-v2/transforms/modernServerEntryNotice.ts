import { SyntaxKind } from 'ts-morph';

import type { Diagnostic, Transform, TransformResult } from '../../../types';
import { info } from '../../../utils/diagnostics';

const MODERN_PROTOCOL_GUIDE = 'https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28#serving-the-2026-07-28-revision';

const LEGACY_SERVER_TRANSPORTS = new Map([
    [
        '@modelcontextprotocol/server/stdio:StdioServerTransport',
        'This StdioServerTransport entry serves 2025-era clients only. To also serve protocol revision 2026-07-28, use serveStdio(() => createServer()).'
    ],
    [
        '@modelcontextprotocol/node:NodeStreamableHTTPServerTransport',
        'This NodeStreamableHTTPServerTransport entry serves 2025-era clients only. To also serve protocol revision 2026-07-28, use createMcpHandler(() => createServer()).'
    ],
    [
        '@modelcontextprotocol/server:WebStandardStreamableHTTPServerTransport',
        'This WebStandardStreamableHTTPServerTransport entry serves 2025-era clients only. To also serve protocol revision 2026-07-28, use createMcpHandler(() => createServer()).'
    ]
]);

export const modernServerEntryNoticeTransform: Transform = {
    name: 'Modern server entry notices',
    id: 'modern-server-entry-notices',
    apply(sourceFile): TransformResult {
        const diagnostics: Diagnostic[] = [];
        const filePath = sourceFile.getFilePath();

        for (const declaration of sourceFile.getImportDeclarations()) {
            const specifier = declaration.getModuleSpecifierValue();

            for (const namedImport of declaration.getNamedImports()) {
                const message = LEGACY_SERVER_TRANSPORTS.get(`${specifier}:${namedImport.getName()}`);
                if (message === undefined || namedImport.isTypeOnly() || declaration.isTypeOnly()) continue;

                const binding = namedImport.getAliasNode() ?? namedImport.getNameNode().asKind(SyntaxKind.Identifier);
                if (binding === undefined) continue;
                const construction = binding
                    .findReferencesAsNodes()
                    .map(reference => reference.getParentIfKind(SyntaxKind.NewExpression))
                    .find(node => node?.getExpression().getText() === binding.getText());
                if (construction === undefined) continue;

                diagnostics.push({
                    ...info(filePath, construction.getStartLineNumber(), `${message} See ${MODERN_PROTOCOL_GUIDE}.`),
                    advisoryOnly: true
                });
            }
        }

        return { changesCount: 0, diagnostics };
    }
};
