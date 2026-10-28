import { describe, expect, it } from 'vitest';

import { mimeTypeFor } from '../../../src/ext/skills/mime';

describe('mimeTypeFor', () => {
    it('maps known extensions, case-insensitively', () => {
        expect(mimeTypeFor('SKILL.md')).toBe('text/markdown');
        expect(mimeTypeFor('chart.PNG')).toBe('image/png');
    });

    it.each(['notes', '.env', 'archive.unknown', 'notes.__proto__', 'x.constructor', 'x.hasOwnProperty', 'x.valueOf'])(
        'falls back to application/octet-stream for %s',
        name => {
            expect(mimeTypeFor(name)).toBe('application/octet-stream');
        }
    );
});
