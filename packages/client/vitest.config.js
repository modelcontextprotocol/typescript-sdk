import baseConfig from '@modelcontextprotocol/vitest-config';
import { mergeConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default mergeConfig(baseConfig, {
    test: {
        setupFiles: ['./vitest.setup.ts']
    },
    resolve: {
        alias: {
            // Use workspace source packages instead of built dist/ for tests
            '@modelcontextprotocol/sdk-core': path.resolve(__dirname, '../core/src/index.ts'),
            '@modelcontextprotocol/sdk-core/types': path.resolve(__dirname, '../core/src/exports/types/index.ts'),
            '@modelcontextprotocol/sdk-client': path.resolve(__dirname, '../client/src/index.ts'),
            '@modelcontextprotocol/sdk-server': path.resolve(__dirname, '../server/src/index.ts')
        }
    }
});
