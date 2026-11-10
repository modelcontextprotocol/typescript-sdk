import { UriTemplate } from '../../src/shared/uriTemplate';

describe('UriTemplate', () => {
    describe('isTemplate', () => {
        it('should return true for strings containing template expressions', () => {
            expect(UriTemplate.isTemplate('{foo}')).toBe(true);
            expect(UriTemplate.isTemplate('/users/{id}')).toBe(true);
            expect(UriTemplate.isTemplate('http://example.com/{path}/{file}')).toBe(true);
            expect(UriTemplate.isTemplate('/search{?q,limit}')).toBe(true);
        });

        it('should return false for strings without template expressions', () => {
            expect(UriTemplate.isTemplate('')).toBe(false);
            expect(UriTemplate.isTemplate('plain string')).toBe(false);
            expect(UriTemplate.isTemplate('http://example.com/foo/bar')).toBe(false);
            expect(UriTemplate.isTemplate('{}')).toBe(false); // Empty braces don't count
            expect(UriTemplate.isTemplate('{ }')).toBe(false); // Just whitespace doesn't count
        });
    });

    describe('simple string expansion', () => {
        it('should expand simple string variables', () => {
            const template = new UriTemplate('http://example.com/users/{username}');
            expect(template.expand({ username: 'fred' })).toBe('http://example.com/users/fred');
            expect(template.variableNames).toEqual(['username']);
        });

        it('should handle multiple variables', () => {
            const template = new UriTemplate('{x,y}');
            expect(template.expand({ x: '1024', y: '768' })).toBe('1024,768');
            expect(template.variableNames).toEqual(['x', 'y']);
        });

        it('should encode reserved characters', () => {
            const template = new UriTemplate('{var}');
            expect(template.expand({ var: 'value with spaces' })).toBe('value%20with%20spaces');
        });
    });

    describe('reserved expansion', () => {
        it('should not encode reserved characters with + operator', () => {
            const template = new UriTemplate('{+path}/here');
            expect(template.expand({ path: '/foo/bar' })).toBe('/foo/bar/here');
            expect(template.variableNames).toEqual(['path']);
        });
    });

    describe('fragment expansion', () => {
        it('should add # prefix and not encode reserved chars', () => {
            const template = new UriTemplate('X{#var}');
            expect(template.expand({ var: '/test' })).toBe('X#/test');
            expect(template.variableNames).toEqual(['var']);
        });
    });

    describe('label expansion', () => {
        it('should add . prefix', () => {
            const template = new UriTemplate('X{.var}');
            expect(template.expand({ var: 'test' })).toBe('X.test');
            expect(template.variableNames).toEqual(['var']);
        });
    });

    describe('path expansion', () => {
        it('should add / prefix', () => {
            const template = new UriTemplate('X{/var}');
            expect(template.expand({ var: 'test' })).toBe('X/test');
            expect(template.variableNames).toEqual(['var']);
        });
    });

    describe('query expansion', () => {
        it('should add ? prefix and name=value format', () => {
            const template = new UriTemplate('X{?var}');
            expect(template.expand({ var: 'test' })).toBe('X?var=test');
            expect(template.variableNames).toEqual(['var']);
        });
    });

    describe('form continuation expansion', () => {
        it('should add & prefix and name=value format', () => {
            const template = new UriTemplate('X{&var}');
            expect(template.expand({ var: 'test' })).toBe('X&var=test');
            expect(template.variableNames).toEqual(['var']);
        });
    });

    describe('matching', () => {
        it('should match simple strings and extract variables', () => {
            const template = new UriTemplate('http://example.com/users/{username}');
            const match = template.match('http://example.com/users/fred');
            expect(match).toEqual({ username: 'fred' });
        });

        it('should match multiple variables', () => {
            const template = new UriTemplate('/users/{username}/posts/{postId}');
            const match = template.match('/users/fred/posts/123');
            expect(match).toEqual({ username: 'fred', postId: '123' });
        });

        it('should return null for non-matching URIs', () => {
            const template = new UriTemplate('/users/{username}');
            const match = template.match('/posts/123');
            expect(match).toBeNull();
        });

        it('should handle exploded arrays', () => {
            const template = new UriTemplate('{/list*}');
            const match = template.match('/red,green,blue');
            expect(match).toEqual({ list: ['red', 'green', 'blue'] });
        });
    });

    describe('edge cases', () => {
        it('should handle empty variables', () => {
            const template = new UriTemplate('{empty}');
            expect(template.expand({})).toBe('');
            expect(template.expand({ empty: '' })).toBe('');
        });

        it('should handle undefined variables', () => {
            const template = new UriTemplate('{a}{b}{c}');
            expect(template.expand({ b: '2' })).toBe('2');
        });

        it('should handle special characters in variable names', () => {
            const template = new UriTemplate('{$var_name}');
            expect(template.expand({ $var_name: 'value' })).toBe('value');
        });
    });

    describe('complex patterns', () => {
        it('should handle nested path segments', () => {
            const template = new UriTemplate('/api/{version}/{resource}/{id}');
            expect(
                template.expand({
                    version: 'v1',
                    resource: 'users',
                    id: '123'
                })
            ).toBe('/api/v1/users/123');
            expect(template.variableNames).toEqual(['version', 'resource', 'id']);
        });

        it('should handle query parameters with arrays', () => {
            const template = new UriTemplate('/search{?tags*}');
            expect(
                template.expand({
                    tags: ['nodejs', 'typescript', 'testing']
                })
            ).toBe('/search?tags=nodejs,typescript,testing');
            expect(template.variableNames).toEqual(['tags']);
        });

        it('should handle multiple query parameters', () => {
            const template = new UriTemplate('/search{?q,page,limit}');
            expect(
                template.expand({
                    q: 'test',
                    page: '1',
                    limit: '10'
                })
            ).toBe('/search?q=test&page=1&limit=10');
            expect(template.variableNames).toEqual(['q', 'page', 'limit']);
        });
    });

    describe('matching complex patterns', () => {
        it('should match nested path segments', () => {
            const template = new UriTemplate('/api/{version}/{resource}/{id}');
            const match = template.match('/api/v1/users/123');
            expect(match).toEqual({
                version: 'v1',
                resource: 'users',
                id: '123'
            });
            expect(template.variableNames).toEqual(['version', 'resource', 'id']);
        });

        it('should match query parameters', () => {
            const template = new UriTemplate('/search{?q}');
            const match = template.match('/search?q=test');
            expect(match).toEqual({ q: 'test' });
            expect(template.variableNames).toEqual(['q']);
        });

        it('should match multiple query parameters', () => {
            const template = new UriTemplate('/search{?q,page}');
            const match = template.match('/search?q=test&page=1');
            expect(match).toEqual({ q: 'test', page: '1' });
            expect(template.variableNames).toEqual(['q', 'page']);
        });

        it('should handle partial matches correctly', () => {
            const template = new UriTemplate('/users/{id}');
            expect(template.match('/users/123/extra')).toBeNull();
            expect(template.match('/users')).toBeNull();
        });
    });

    describe('security and edge cases', () => {
        it('should handle extremely long input strings', () => {
            const longString = 'x'.repeat(100_000);
            const template = new UriTemplate(`/api/{param}`);
            expect(template.expand({ param: longString })).toBe(`/api/${longString}`);
            expect(template.match(`/api/${longString}`)).toEqual({ param: longString });
        });

        it('should handle deeply nested template expressions', () => {
            const template = new UriTemplate('{a}{b}{c}{d}{e}{f}{g}{h}{i}{j}'.repeat(1000));
            expect(() =>
                template.expand({
                    a: '1',
                    b: '2',
                    c: '3',
                    d: '4',
                    e: '5',
                    f: '6',
                    g: '7',
                    h: '8',
                    i: '9',
                    j: '0'
                })
            ).not.toThrow();
        });

        it('should handle malformed template expressions', () => {
            expect(() => new UriTemplate('{unclosed')).toThrow();
            expect(() => new UriTemplate('{}')).not.toThrow();
            expect(() => new UriTemplate('{,}')).not.toThrow();
            expect(() => new UriTemplate('{a}{')).toThrow();
        });

        it('should handle pathological regex patterns', () => {
            const template = new UriTemplate('/api/{param}');
            // Create a string that could cause catastrophic backtracking
            const input = '/api/' + 'a'.repeat(100_000);
            expect(() => template.match(input)).not.toThrow();
        });

        it('should handle invalid UTF-8 sequences', () => {
            const template = new UriTemplate('/api/{param}');
            const invalidUtf8 = '���';
            expect(() => template.expand({ param: invalidUtf8 })).not.toThrow();
            expect(() => template.match(`/api/${invalidUtf8}`)).not.toThrow();
        });

        it('should handle template/URI length mismatches', () => {
            const template = new UriTemplate('/api/{param}');
            expect(template.match('/api/')).toBeNull();
            expect(template.match('/api')).toBeNull();
            expect(template.match('/api/value/extra')).toBeNull();
        });

        it('should handle repeated operators', () => {
            const template = new UriTemplate('{?a}{?b}{?c}');
            expect(template.expand({ a: '1', b: '2', c: '3' })).toBe('?a=1&b=2&c=3');
            expect(template.variableNames).toEqual(['a', 'b', 'c']);
        });

        it('should handle overlapping variable names', () => {
            const template = new UriTemplate('{var}{vara}');
            expect(template.expand({ var: '1', vara: '2' })).toBe('12');
            expect(template.variableNames).toEqual(['var', 'vara']);
        });

        it('should handle empty segments', () => {
            const template = new UriTemplate('///{a}////{b}////');
            expect(template.expand({ a: '1', b: '2' })).toBe('///1////2////');
            expect(template.match('///1////2////')).toEqual({ a: '1', b: '2' });
            expect(template.variableNames).toEqual(['a', 'b']);
        });

        it('should handle maximum template expression limit', () => {
            // Create a template with many expressions
            const expressions = Array.from({ length: 10_000 }).fill('{param}').join('');
            expect(() => new UriTemplate(expressions)).not.toThrow();
        });

        it('should handle maximum variable name length', () => {
            const longName = 'a'.repeat(10_000);
            const template = new UriTemplate(`{${longName}}`);
            const vars: Record<string, string> = { [longName]: 'value' };
            expect(() => template.expand(vars)).not.toThrow();
        });

        it('should not be vulnerable to ReDoS with exploded path patterns', () => {
            // Test for ReDoS vulnerability (CVE-2026-0621)
            // See: https://github.com/modelcontextprotocol/typescript-sdk/issues/965
            const template = new UriTemplate('{/id*}');
            const maliciousPayload = '/' + ','.repeat(50);

            const startTime = Date.now();
            template.match(maliciousPayload);
            const elapsed = Date.now() - startTime;

            // Should complete in under 100ms, not hang for seconds
            expect(elapsed).toBeLessThan(100);
        });

        it('should not be vulnerable to ReDoS with exploded simple patterns', () => {
            // Test for ReDoS vulnerability with simple exploded operator
            const template = new UriTemplate('{id*}');
            const maliciousPayload = ','.repeat(50);

            const startTime = Date.now();
            template.match(maliciousPayload);
            const elapsed = Date.now() - startTime;

            // Should complete in under 100ms, not hang for seconds
            expect(elapsed).toBeLessThan(100);
        });
    });

    describe('RFC 6570 prefix modifier', () => {
        it('should report variableNames without the prefix modifier', () => {
            const template = new UriTemplate('resource:///{name:3}');
            expect(template.variableNames).toEqual(['name']);
        });

        it('should truncate scalar values to prefix length for simple string expansion', () => {
            const template = new UriTemplate('{name:3}');
            expect(template.expand({ name: 'abcdef' })).toBe('abc');
            expect(template.variableNames).toEqual(['name']);
        });

        it('should expand prefix in URI path context', () => {
            const template = new UriTemplate('resource:///{name:3}');
            expect(template.expand({ name: 'abcdef' })).toBe('resource:///abc');
        });

        it('should apply prefix to Unicode code points before percent-encoding', () => {
            const template = new UriTemplate('{name:2}');
            expect(template.expand({ name: '你好世界' })).toBe(encodeURIComponent('你好'));
        });

        it('should handle supplementary Unicode characters (surrogate pairs)', () => {
            const template = new UriTemplate('{emoji:2}');
            expect(template.expand({ emoji: '👋🌍🎉' })).toBe(encodeURIComponent('👋🌍'));
        });

        it('should use the entire string when prefix is longer than value', () => {
            const template = new UriTemplate('{name:30}');
            expect(template.expand({ name: 'abcdef' })).toBe('abcdef');
        });

        it('should return empty string when variable is missing', () => {
            const template = new UriTemplate('{name:3}');
            expect(template.expand({})).toBe('');
        });

        it('should support prefix modifiers with reserved expansion (+ operator)', () => {
            const template = new UriTemplate('{+path:4}/here');
            expect(template.expand({ path: '/foo/bar' })).toBe('/foo/here');
            expect(template.variableNames).toEqual(['path']);
        });

        it('should support prefix modifiers with fragment operator (#)', () => {
            const template = new UriTemplate('X{#var:2}');
            expect(template.expand({ var: '/test' })).toBe('X#/t');
            expect(template.variableNames).toEqual(['var']);
        });

        it('should support prefix modifiers with label operator (.)', () => {
            const template = new UriTemplate('X{.var:2}');
            expect(template.expand({ var: 'test' })).toBe('X.te');
            expect(template.variableNames).toEqual(['var']);
        });

        it('should support prefix modifiers with path operator (/)', () => {
            const template = new UriTemplate('X{/var:2}');
            expect(template.expand({ var: 'test' })).toBe('X/te');
            expect(template.variableNames).toEqual(['var']);
        });

        it('should support prefix modifiers with query operator (?)', () => {
            const template = new UriTemplate('X{?var:2}');
            expect(template.expand({ var: 'test' })).toBe('X?var=te');
            expect(template.variableNames).toEqual(['var']);
        });

        it('should support prefix modifiers with form continuation operator (&)', () => {
            const template = new UriTemplate('X{&var:2}');
            expect(template.expand({ var: 'test' })).toBe('X&var=te');
            expect(template.variableNames).toEqual(['var']);
        });

        it('should ignore prefix modifier on composite (array) values per RFC 6570', () => {
            const template = new UriTemplate('{list:2}');
            expect(template.expand({ list: ['red', 'green'] })).toBe('red,green');
            expect(template.variableNames).toEqual(['list']);
        });

        it('should handle multiple variables with prefix modifiers and encode values', () => {
            const template = new UriTemplate('{x,y:2}');
            expect(template.expand({ x: '1024', y: 'é ü' })).toBe('1024,%C3%A9%20');
            expect(template.variableNames).toEqual(['x', 'y']);
        });

        it('should join multiple variables using the operator separator', () => {
            const pathTemplate = new UriTemplate('{/x,y}');
            expect(pathTemplate.expand({ x: '1024', y: '768' })).toBe('/1024/768');

            const labelTemplate = new UriTemplate('{.x,y}');
            expect(labelTemplate.expand({ x: '1024', y: '768' })).toBe('.1024.768');

            const fragTemplate = new UriTemplate('{#x,y}');
            expect(fragTemplate.expand({ x: '1024', y: '768' })).toBe('#1024,768');

            const partialTemplate = new UriTemplate('{/x,y}');
            expect(partialTemplate.expand({ x: '1024' })).toBe('/1024');
        });

        it('should match URIs and extract variables for templates with prefix modifiers', () => {
            const template = new UriTemplate('resource:///{name:3}');
            expect(template.match('resource:///abc')).toEqual({ name: 'abc' });
        });

        it('pins that match() extracts the segment value without enforcing prefix truncation', () => {
            const template = new UriTemplate('/users/{id:3}');
            // Prefix modifiers apply during expansion (RFC 6570); match() extracts the matched segment
            expect(template.match('/users/abc')).toEqual({ id: 'abc' });
            expect(template.match('/users/abcdef')).toEqual({ id: 'abcdef' });
        });

        it('should match query parameters for templates with prefix modifiers', () => {
            const template = new UriTemplate('/search{?q:5}');
            expect(template.match('/search?q=hello')).toEqual({ q: 'hello' });
        });

        describe('malformed and combined modifier boundary cases', () => {
            it('should not resolve prefix of :0 and preserve unresolved behavior', () => {
                const template = new UriTemplate('{name:0}');
                expect(template.variableNames).toEqual(['name:0']);
                expect(template.expand({ name: 'abcdef' })).toBe('');
            });

            it('should not resolve prefix with five or more digits and preserve unresolved behavior', () => {
                const template = new UriTemplate('{name:10000}');
                expect(template.variableNames).toEqual(['name:10000']);
                expect(template.expand({ name: 'abcdef' })).toBe('');
            });

            it('should not resolve non-digit prefix and preserve unresolved behavior', () => {
                const template = new UriTemplate('{name:abc}');
                expect(template.variableNames).toEqual(['name:abc']);
                expect(template.expand({ name: 'abcdef' })).toBe('');
            });

            it('should reject combined prefix and explode modifiers :N* and preserve unresolved behavior', () => {
                const template = new UriTemplate('{name:3*}');
                expect(template.variableNames).toEqual(['name:3']);
                expect(template.expand({ name: 'abcdef' })).toBe('');
            });

            it('should accept valid upper boundary prefix length (up to 4 digits, e.g. 9999)', () => {
                const template = new UriTemplate('{name:9999}');
                expect(template.variableNames).toEqual(['name']);
                expect(template.expand({ name: 'abcdef' })).toBe('abcdef');
            });
        });
    });
});
