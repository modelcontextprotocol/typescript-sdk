import { describe, expect, it } from 'vitest';

import {
    buildQualifiedToolDefinitions,
    buildQualifiedToolName,
    createUniqueServerLabel,
    sanitizeServerLabel
} from '../src/multiServerHelpers.js';

describe('multiServerHelpers', () => {
    it('sanitizes server labels into stable lowercase identifiers', () => {
        expect(sanitizeServerLabel('C:/Projects/Weather Server.ts')).toBe('weather_server');
        expect(sanitizeServerLabel('/tmp/123 Demo Server.py')).toBe('server_123_demo_server');
        expect(sanitizeServerLabel('/tmp/---.js')).toBe('server');
    });

    it('deduplicates labels when two server scripts share the same base name', () => {
        const usedLabels = new Set<string>();

        expect(createUniqueServerLabel('/tmp/weather.ts', usedLabels)).toBe('weather');
        expect(createUniqueServerLabel('/work/weather.py', usedLabels)).toBe('weather_2');
        expect(createUniqueServerLabel('/work/weather.ts', usedLabels)).toBe('weather_3');
    });

    it('builds qualified tool definitions with server context in the tool description', () => {
        const [qualifiedTool] = buildQualifiedToolDefinitions('weather', [
            {
                name: 'forecast',
                description: 'Look up a forecast by city.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        city: { type: 'string' }
                    }
                }
            }
        ]);

        expect(buildQualifiedToolName('weather', 'forecast')).toBe('weather__forecast');
        expect(qualifiedTool).toEqual({
            originalToolName: 'forecast',
            qualifiedToolName: 'weather__forecast',
            serverLabel: 'weather',
            anthropicTool: {
                name: 'weather__forecast',
                description:
                    '[server:weather] Original MCP tool: forecast. Look up a forecast by city.',
                input_schema: {
                    type: 'object',
                    properties: {
                        city: { type: 'string' }
                    }
                }
            }
        });
    });
});
