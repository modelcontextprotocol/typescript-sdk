import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'node:path';
import url from 'node:url';

const ignorePatterns = ['**/dist/**'];
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.ts'],
        exclude: ignorePatterns,
        deps: {
            moduleDirectories: ['node_modules', path.resolve(__dirname, '../../packages'), path.resolve(__dirname, '../../common')]
        },
        poolOptions: {
            threads: {
                useAtomics: true
            }
        }
    },
    plugins: [tsconfigPaths()]
});
