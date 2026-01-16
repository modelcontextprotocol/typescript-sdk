import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
    'packages/**/vitest.config.js',
    'examples/**/vitest.config.js',
    'test/**/vitest.config.js',
]);
