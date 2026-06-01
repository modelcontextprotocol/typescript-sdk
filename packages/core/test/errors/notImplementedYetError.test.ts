import { describe, expect, it } from 'vitest';

import { NotImplementedYetError } from '../../src/errors/notImplementedYetError.js';

describe('NotImplementedYetError', () => {
    it('is an Error with the class name and the given message', () => {
        const error = new NotImplementedYetError('stateless request dispatch is not implemented yet');

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(NotImplementedYetError);
        expect(error.name).toBe('NotImplementedYetError');
        expect(error.message).toBe('stateless request dispatch is not implemented yet');
    });

    it('is distinguishable from plain errors via instanceof', () => {
        expect(new Error('x')).not.toBeInstanceOf(NotImplementedYetError);
    });
});
