import { UriTemplate } from './uriTemplate.js';

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
            const longString = 'x'.repeat(100000);
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
            const input = '/api/' + 'a'.repeat(100000);
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
            const expressions = Array(10000).fill('{param}').join('');
            expect(() => new UriTemplate(expressions)).not.toThrow();
        });

        it('should handle maximum variable name length', () => {
            const longName = 'a'.repeat(10000);
            const template = new UriTemplate(`{${longName}}`);
            const vars: Record<string, string> = {};
            vars[longName] = 'value';
            expect(() => template.expand(vars)).not.toThrow();
        });
    });
});
