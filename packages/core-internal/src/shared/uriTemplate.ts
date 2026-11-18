// Claude-authored implementation of RFC 6570 URI Templates

export type Variables = Record<string, string | string[]>;

const MAX_TEMPLATE_LENGTH = 1_000_000; // 1MB
const MAX_VARIABLE_LENGTH = 1_000_000; // 1MB
const MAX_TEMPLATE_EXPRESSIONS = 10_000;
const MAX_REGEX_LENGTH = 1_000_000; // 1MB

type TemplatePart = {
    name: string;
    operator: string;
    names: string[];
    exploded: boolean;
    /** Set by a trailing `?` on the variable, e.g. `{name?}`: the segment may be absent. */
    optional: boolean;
};

// Operators whose expansion is empty when the variable is undefined, so a match must tolerate the segment being absent.
const PREFIXED_SEGMENT_OPERATORS = new Set(['/', '.']);

export class UriTemplate {
    /**
     * Returns true if the given string contains any URI template expressions.
     * A template expression is a sequence of characters enclosed in curly braces,
     * like `{foo}` or `{?bar}`.
     */
    static isTemplate(str: string): boolean {
        // Look for any sequence of characters between curly braces
        // that isn't just whitespace
        return /\{[^}\s]+\}/.test(str);
    }

    private static validateLength(str: string, max: number, context: string): void {
        if (str.length > max) {
            throw new Error(`${context} exceeds maximum length of ${max} characters (got ${str.length})`);
        }
    }
    private readonly template: string;
    private readonly parts: Array<string | TemplatePart>;

    get variableNames(): string[] {
        return this.parts.flatMap(part => (typeof part === 'string' ? [] : part.names));
    }

    constructor(template: string) {
        UriTemplate.validateLength(template, MAX_TEMPLATE_LENGTH, 'Template');
        this.template = template;
        this.parts = this.parse(template);
    }

    toString(): string {
        return this.template;
    }

    private parse(template: string): Array<string | TemplatePart> {
        const parts: Array<string | TemplatePart> = [];
        let currentText = '';
        let i = 0;
        let expressionCount = 0;

        while (i < template.length) {
            if (template[i] === '{') {
                if (currentText) {
                    parts.push(currentText);
                    currentText = '';
                }
                const end = template.indexOf('}', i);
                if (end === -1) throw new Error('Unclosed template expression');

                expressionCount++;
                if (expressionCount > MAX_TEMPLATE_EXPRESSIONS) {
                    throw new Error(`Template contains too many expressions (max ${MAX_TEMPLATE_EXPRESSIONS})`);
                }

                const expr = template.slice(i + 1, end);
                const operator = this.getOperator(expr);
                const exploded = expr.includes('*');
                const optional = expr.trimEnd().endsWith('?');
                const names = this.getNames(expr);
                const name = names[0]!;

                // Validate variable name length
                for (const name of names) {
                    UriTemplate.validateLength(name, MAX_VARIABLE_LENGTH, 'Variable name');
                }

                parts.push({ name, operator, names, exploded, optional });
                i = end + 1;
            } else {
                currentText += template[i];
                i++;
            }
        }

        if (currentText) {
            parts.push(currentText);
        }

        return parts;
    }

    private getOperator(expr: string): string {
        const operators = ['+', '#', '.', '/', '?', '&'];
        return operators.find(op => expr.startsWith(op)) || '';
    }

    private getNames(expr: string): string[] {
        const operator = this.getOperator(expr);
        return expr
            .slice(operator.length)
            .split(',')
            .map(name => name.replace('*', '').trim().replace(/\?$/, ''))
            .filter(name => name.length > 0);
    }

    private encodeValue(value: string, operator: string): string {
        UriTemplate.validateLength(value, MAX_VARIABLE_LENGTH, 'Variable value');
        if (operator === '+' || operator === '#') {
            return encodeURI(value);
        }
        return encodeURIComponent(value);
    }

    private expandPart(part: TemplatePart, variables: Variables): string {
        if (part.operator === '?' || part.operator === '&') {
            const pairs = part.names
                .map(name => {
                    const value = variables[name];
                    if (value === undefined) return '';
                    const encoded = Array.isArray(value)
                        ? value.map(v => this.encodeValue(v, part.operator)).join(',')
                        : this.encodeValue(value.toString(), part.operator);
                    return `${name}=${encoded}`;
                })
                .filter(pair => pair.length > 0);

            if (pairs.length === 0) return '';
            const separator = part.operator === '?' ? '?' : '&';
            return separator + pairs.join('&');
        }

        if (part.names.length > 1) {
            const values = part.names.map(name => variables[name]).filter(v => v !== undefined);
            if (values.length === 0) return '';
            return values.map(v => (Array.isArray(v) ? v[0] : v)).join(',');
        }

        const value = variables[part.name];
        if (value === undefined) return '';

        const values = Array.isArray(value) ? value : [value];
        const encoded = values.map(v => this.encodeValue(v, part.operator));

        switch (part.operator) {
            case '': {
                return encoded.join(',');
            }
            case '+': {
                return encoded.join(',');
            }
            case '#': {
                return '#' + encoded.join(',');
            }
            case '.': {
                return '.' + encoded.join('.');
            }
            case '/': {
                return '/' + encoded.join('/');
            }
            default: {
                return encoded.join(',');
            }
        }
    }

    expand(variables: Variables): string {
        let result = '';
        let hasQueryParam = false;

        for (const [index, part] of this.parts.entries()) {
            if (typeof part === 'string') {
                result += part;
                continue;
            }

            const expanded = this.expandPart(part, variables);
            if (!expanded) {
                // An absent `{name?}` takes its leading `/` with it: `a/{b?}` expands to `a`, not `a/`.
                if (this.optionalSeparator(this.parts[index - 1], part)) result = result.slice(0, -1);
                continue;
            }

            // Convert ? to & if we already have a query parameter
            result += (part.operator === '?' || part.operator === '&') && hasQueryParam ? expanded.replace('?', '&') : expanded;

            if (part.operator === '?' || part.operator === '&') {
                hasQueryParam = true;
            }
        }

        return result;
    }

    /** Returns `/` when `literal` ends with the separator that belongs to the optional `{name?}` part following it. */
    private optionalSeparator(literal: string | TemplatePart | undefined, part: string | TemplatePart | undefined): string {
        if (typeof literal !== 'string' || part === undefined || typeof part === 'string') return '';
        return part.optional && literal.endsWith('/') ? '/' : '';
    }

    private escapeRegExp(str: string): string {
        return str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    }

    private partToRegExp(part: TemplatePart): Array<{ pattern: string; name: string }> {
        const patterns: Array<{ pattern: string; name: string }> = [];

        // Validate variable name length for matching
        for (const name of part.names) {
            UriTemplate.validateLength(name, MAX_VARIABLE_LENGTH, 'Variable name');
        }

        if (part.operator === '?' || part.operator === '&') {
            for (let i = 0; i < part.names.length; i++) {
                const name = part.names[i]!;
                const prefix = i === 0 ? '\\' + part.operator : '&';
                patterns.push({
                    pattern: prefix + this.escapeRegExp(name) + '=([^&]+)',
                    name
                });
            }
            return patterns;
        }

        let pattern: string;
        const name = part.name;

        switch (part.operator) {
            case '': {
                pattern = part.exploded ? '([^/,]+(?:,[^/,]+)*)' : '([^/,]+)';
                break;
            }
            case '+':
            case '#': {
                pattern = '(.+)';
                break;
            }
            case '.': {
                pattern = String.raw`\.([^/,]+)`;
                break;
            }
            case '/': {
                pattern = '/' + (part.exploded ? '([^/,]+(?:,[^/,]+)*)' : '([^/,]+)');
                break;
            }
            default: {
                pattern = '([^/]+)';
            }
        }

        patterns.push({ pattern, name });
        return patterns;
    }

    match(uri: string): Variables | null {
        UriTemplate.validateLength(uri, MAX_TEMPLATE_LENGTH, 'URI');
        let pattern = '^';
        const names: Array<{ name: string; exploded: boolean }> = [];

        for (const [index, part] of this.parts.entries()) {
            if (typeof part === 'string') {
                // A separator owned by a following `{name?}` is emitted inside that part's optional group.
                const literal = this.optionalSeparator(part, this.parts[index + 1]) ? part.slice(0, -1) : part;
                pattern += this.escapeRegExp(literal);
                continue;
            }

            const separator = this.optionalSeparator(this.parts[index - 1], part);
            const isOptional = part.optional || PREFIXED_SEGMENT_OPERATORS.has(part.operator);
            for (const { pattern: partPattern, name } of this.partToRegExp(part)) {
                pattern += isOptional ? `(?:${separator}${partPattern})?` : partPattern;
                names.push({ name, exploded: part.exploded });
            }
        }

        pattern += '$';
        UriTemplate.validateLength(pattern, MAX_REGEX_LENGTH, 'Generated regex pattern');
        const regex = new RegExp(pattern);
        const match = uri.match(regex);

        if (!match) return null;

        const result: Variables = {};
        for (const [i, name_] of names.entries()) {
            const { name, exploded } = name_!;
            const value = match[i + 1];
            // Only an optional group can be left unmatched; an absent segment yields no key.
            if (value === undefined) continue;
            const cleanName = name.replace('*', '');

            result[cleanName] = exploded && value.includes(',') ? value.split(',') : value;
        }

        return result;
    }
}
