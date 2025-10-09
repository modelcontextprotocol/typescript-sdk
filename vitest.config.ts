import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            'pkce-challenge': '/src/__mocks__/pkce-challenge.ts'
        }
    },
    test: {
        coverage: {
            include: ['src'],
            exclude: ['src/examples', 'src/__mocks__'],
            reporter: ['json', 'json-summary', 'text']
        }
    }
});
