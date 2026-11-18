/**
 * Gunzip the frozen public catalog and refuse a byte mismatch.
 * Normal tests call this. They do not fetch or regenerate the catalog.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const directory = dirname(fileURLToPath(import.meta.url));

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

export function loadProductionCatalog() {
    const identity = JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8'));
    const gzip = readFileSync(join(directory, 'tools.json.gz'));
    if (sha256(gzip) !== identity.toolsFile.gzipSha256) {
        throw new Error(`production catalog gzip sha256 ${sha256(gzip)}`);
    }
    const raw = gunzipSync(gzip);
    if (raw.length !== identity.toolsFile.rawBytes || sha256(raw) !== identity.toolsFile.rawSha256) {
        throw new Error(`production catalog raw sha256 ${sha256(raw)}`);
    }
    const tools = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(tools) || tools.length !== identity.tools) {
        throw new Error(`production catalog tool count ${tools?.length}`);
    }
    const document = Buffer.from(JSON.stringify({ tools }));
    if (document.length !== identity.toolsFile.documentBytes || sha256(document) !== identity.toolsFile.documentSha256) {
        throw new Error(`production catalog document sha256 ${sha256(document)}`);
    }
    let schemas = 0;
    for (const tool of tools) {
        if (tool?.inputSchema === undefined || tool?.outputSchema === undefined) {
            throw new Error(`production catalog tool ${tool?.name} is missing a schema`);
        }
        schemas += 2;
    }
    if (schemas !== identity.schemas) throw new Error(`production catalog schema count ${schemas}`);
    if (!tools.some(tool => tool.name === identity.invokedTool)) {
        throw new Error(`production catalog is missing ${identity.invokedTool}`);
    }
    const structuredContent = JSON.parse(readFileSync(join(directory, 'binary-session-output.json'), 'utf8'));
    const input = JSON.parse(readFileSync(join(directory, 'binary-session-input.json'), 'utf8'));
    if (sha256(JSON.stringify(structuredContent)) !== identity.structuredContentSha256) {
        throw new Error('production catalog structured content sha256 mismatch');
    }
    return { identity, tools, structuredContent, input };
}
