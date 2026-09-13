import { describe, expect, test } from 'vitest';
import { normalizeHeaders } from '../../src/shared/transport.js';

describe('normalizeHeaders', () => {
  test('returns empty object for undefined', () => {
    expect(normalizeHeaders(undefined)).toEqual({});
  });

  test('copies plain object', () => {
    const input = { 'Content-Type': 'application/json', 'X-Custom': 'value' };
    const result = normalizeHeaders(input);
    expect(result).toEqual(input);
  });

  test('normalizes array of tuples', () => {
    const result = normalizeHeaders([['Content-Type', 'text/plain'], ['Accept', '*/*']]);
    expect(result).toEqual({ 'Content-Type': 'text/plain', 'Accept': '*/*' });
  });

  test('accepts Headers instance', () => {
    const h = new Headers();
    h.set('Authorization', 'Bearer token');
    const result = normalizeHeaders(h);
    expect(result).toEqual({ 'authorization': 'Bearer token' });
  });
});
