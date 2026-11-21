/**
 * Consumers who enable `exactOptionalPropertyTypes` pass Node's own
 * `IncomingMessage` / `ServerResponse` to `toNodeHandler`'s handler, whose
 * optional properties are typed `T | undefined`. The repository does not
 * compile with that flag, so this compiles a consumer snippet with it on.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));

it('accepts Node request and response objects under exactOptionalPropertyTypes', () => {
    const entry = path.join(testDir, '__exactOptionalConsumer.ts');
    const source = [
        "import type { IncomingMessage, ServerResponse } from 'node:http';",
        "import type { NodeIncomingMessageLike, NodeServerResponseLike } from '../src/toNodeHandler';",
        'declare const req: IncomingMessage;',
        'declare const res: ServerResponse;',
        'export const request: NodeIncomingMessageLike = req;',
        'export const response: NodeServerResponseLike = res;'
    ].join('\n');
    const options: ts.CompilerOptions = {
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        types: ['node']
    };
    const host = ts.createCompilerHost(options);
    const { getSourceFile, fileExists, readFile } = host;
    host.getSourceFile = (fileName, languageVersion, ...rest) =>
        fileName === entry ? ts.createSourceFile(fileName, source, languageVersion) : getSourceFile(fileName, languageVersion, ...rest);
    host.fileExists = fileName => fileName === entry || fileExists(fileName);
    host.readFile = fileName => (fileName === entry ? source : readFile(fileName));

    const program = ts.createProgram([entry], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(entry));

    expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
});
