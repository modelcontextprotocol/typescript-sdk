import baseConfig from '../../common/vitest-config/vitest.config.js';
import { mergeConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default mergeConfig(baseConfig, {
    resolve: {
        alias: {
            // Use workspace source files instead of built dist/ for tests
            '@modelcontextprotocol/sdk-core': path.resolve(__dirname, '../core/src/index.ts')
        }
    }
});
