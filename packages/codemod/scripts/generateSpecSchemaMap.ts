import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specTypeSchemaPath = path.resolve(__dirname, '../../core/src/types/specTypeSchema.ts');

const source = readFileSync(specTypeSchemaPath, 'utf8');

// Extract SPEC_SCHEMA_KEYS array entries
const keysMatch = source.match(/const SPEC_SCHEMA_KEYS = \[([\s\S]*?)\] as const/);
if (!keysMatch) throw new Error('Could not find SPEC_SCHEMA_KEYS in specTypeSchema.ts');

const protocolSchemas = [...keysMatch[1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!);

// Extract auth schema keys
const authMatch = source.match(/const authSchemas = \{([\s\S]*?)\} as const/);
if (!authMatch) throw new Error('Could not find authSchemas in specTypeSchema.ts');

const authSchemas = [...authMatch[1]!.matchAll(/(\w+Schema)/g)].map(m => m[1]!);

const allSchemas = [...protocolSchemas, ...authSchemas].sort();

const entries = allSchemas.map((s, i) => `    '${s}'${i < allSchemas.length - 1 ? ',' : ''}`).join('\n');

const output = `// AUTO-GENERATED — do not edit. Run \`pnpm run generate:spec-schemas\` to regenerate.
export const SPEC_SCHEMA_NAMES: ReadonlySet<string> = new Set([
${entries}
]);

export function specSchemaToTypeName(schemaName: string): string | undefined {
    if (!SPEC_SCHEMA_NAMES.has(schemaName)) return undefined;
    return schemaName.slice(0, -'Schema'.length);
}
`;

const outPath = path.resolve(__dirname, '../src/generated/specSchemaMap.ts');
writeFileSync(outPath, output);
console.log(`Wrote ${outPath} (${allSchemas.length} schemas)`);
