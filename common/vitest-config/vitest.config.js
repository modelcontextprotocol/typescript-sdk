import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'node:path';
import url from 'node:url';

const ignorePatterns = ['**/dist/**'];
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const reporters = ['default'];
const outputFile = {};

if (process.env.GITHUB_ACTIONS === 'true') {
    reporters.push([import.meta.resolve('vitest-sonar-reporter'), { silent: true }], 'github-actions');
    outputFile['vitest-sonar-reporter'] = 'reports/sonar-report.xml';
}

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.ts'],
        exclude: ignorePatterns,
        reporters,
        outputFile,
        deps: {
            moduleDirectories: ['node_modules', path.resolve(__dirname, '../../packages'), path.resolve(__dirname, '../../common')]
        },
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html', 'lcov'],
            reportsDirectory: './coverage',
            include: ['src/**/*.ts'],
            exclude: ['**/dist/**', '**/node_modules/**', '**/*.test.ts', '**/*.spec.ts'],
        },
    },
    poolOptions: {
        threads: {
            useAtomics: true
        }
    },
    plugins: [tsconfigPaths()]
});
