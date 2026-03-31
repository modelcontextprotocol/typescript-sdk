/**
 * Tests for the demo OAuth provider using better-auth
 *
 * DEMO ONLY - NOT FOR PRODUCTION
 *
 * The demo OAuth provider now uses better-auth with the MCP plugin.
 * These tests verify the basic setup works correctly.
 */

import { describe, expect, it } from 'vitest';

import type { CreateDemoAuthOptions } from '../src/auth.js';
import { createDemoAuth } from '../src/auth.js';

describe('createDemoAuth', () => {
    const validOptions: CreateDemoAuthOptions = {
        baseURL: 'http://localhost:3001',
        resource: 'http://localhost:3000/mcp',
        loginPage: '/sign-in',
        demoMode: true
    };

    it('creates a better-auth instance with MCP plugin', () => {
        const auth = createDemoAuth(validOptions);
        expect(auth).toBeDefined();
        expect(auth.api).toBeDefined();
    });

    it('uses default loginPage when not specified', () => {
        const options: CreateDemoAuthOptions = {
            baseURL: 'http://localhost:3001',
            demoMode: true
        };
        const auth = createDemoAuth(options);
        expect(auth).toBeDefined();
    });
});
