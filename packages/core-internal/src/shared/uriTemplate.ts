// Claude-authored implementation of RFC 6570 URI Templates

export type Variables = Record<string, string | string[]>;

const MAX_TEMPLATE_LENGTH = 1_000_000; // 1MB
const MAX_VARIABLE_LENGTH = 1_000_000; // 1MB
const MAX_TEMPLATE_EXPRESSIONS = 10_000;
const MAX_REGEX_LENGTH = 1_000_000; // 1MB

interface VarSpec {
    name: string;
    exploded: boolean;
    prefix?: number;
}

interface TemplateExpressionPart {
    name: string;
    operator: string;
    names: string[];
    exploded: boolean;
    vars: VarSpec[];
}

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
    private readonly parts: Array<string | TemplateExpressionPart>;

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

    private parse(template: string): Array<string | TemplateExpressionPart> {
        const parts: Array<string | TemplateExpressionPart> = [];
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
                const vars = this.getVarSpecs(expr);
                const names = vars.map(v => v.name);
                const name = names[0]!;

                // Validate variable name length
                for (const name of names) {
                    UriTemplate.validateLength(name, MAX_VARIABLE_LENGTH, 'Variable name');
                }

                parts.push({ name, operator, names, exploded, vars });
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

    private parseVarSpec(spec: string): VarSpec {
        const trimmed = spec.trim();

        // Prefix and explode modifiers are mutually exclusive per RFC 6570
        if (trimmed.includes(':') && trimmed.includes('*')) {
            return { name: trimmed.replaceAll('*', '').trim(), exploded: false };
        }

        if (trimmed.endsWith('*')) {
            const name = trimmed.slice(0, -1).trim();
            return { name, exploded: true };
        }

        const colonIndex = trimmed.indexOf(':');
        if (colonIndex !== -1) {
            const name = trimmed.slice(0, colonIndex).trim();
            const prefixStr = trimmed.slice(colonIndex + 1).trim();
            // RFC 6570 defines max-length as 1*4DIGIT (non-zero positive integer < 10000)
            if (/^[1-9]\d{0,3}$/.test(prefixStr)) {
                return {
                    name,
                    exploded: false,
                    prefix: Number.parseInt(prefixStr, 10)
                };
            }
            // Malformed prefix (e.g. :0, :10000, :abc) - preserve unresolved behavior
            return { name: trimmed, exploded: false };
        }

        return { name: trimmed, exploded: false };
    }

    private getVarSpecs(expr: string): VarSpec[] {
        const operator = this.getOperator(expr);
        return expr
            .slice(operator.length)
            .split(',')
            .map(spec => this.parseVarSpec(spec))
            .filter(v => v.name.length > 0);
    }

    private getNames(expr: string): string[] {
        return this.getVarSpecs(expr).map(v => v.name);
    }

    private applyPrefix(value: string, prefix?: number): string {
        if (prefix === undefined || prefix <= 0) {
            return value;
        }
        return [...value].slice(0, prefix).join('');
    }

    private encodeValue(value: string, operator: string): string {
        UriTemplate.validateLength(value, MAX_VARIABLE_LENGTH, 'Variable value');
        if (operator === '+' || operator === '#') {
            return encodeURI(value);
        }
        return encodeURIComponent(value);
    }

    private expandPart(part: TemplateExpressionPart, variables: Variables): string {
        if (part.operator === '?' || part.operator === '&') {
            const pairs = part.vars
                .map(v => {
                    const value = variables[v.name];
                    if (value === undefined) return '';
                    const encoded = Array.isArray(value)
                        ? value.map(val => this.encodeValue(val, part.operator)).join(',')
                        : this.encodeValue(this.applyPrefix(value.toString(), v.prefix), part.operator);
                    return `${v.name}=${encoded}`;
                })
                .filter(pair => pair.length > 0);

            if (pairs.length === 0) return '';
            const separator = part.operator === '?' ? '?' : '&';
            return separator + pairs.join('&');
        }

        const encoded: string[] = [];
        for (const v of part.vars) {
            const value = variables[v.name];
            if (value === undefined) continue;
            if (Array.isArray(value)) {
                for (const item of value) {
                    encoded.push(this.encodeValue(item, part.operator));
                }
            } else {
                const str = this.applyPrefix(value.toString(), v.prefix);
                encoded.push(this.encodeValue(str, part.operator));
            }
        }

        if (encoded.length === 0) return '';

        switch (part.operator) {
            case '':
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

        for (const part of this.parts) {
            if (typeof part === 'string') {
                result += part;
                continue;
            }

            const expanded = this.expandPart(part, variables);
            if (!expanded) continue;

            // Convert ? to & if we already have a query parameter
            result += (part.operator === '?' || part.operator === '&') && hasQueryParam ? expanded.replace('?', '&') : expanded;

            if (part.operator === '?' || part.operator === '&') {
                hasQueryParam = true;
            }
        }

        return result;
    }

    private escapeRegExp(str: string): string {
        return str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    }

    private partToRegExp(part: TemplateExpressionPart): Array<{ pattern: string; name: string }> {
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

        for (const part of this.parts) {
            if (typeof part === 'string') {
                pattern += this.escapeRegExp(part);
            } else {
                const patterns = this.partToRegExp(part);
                for (const { pattern: partPattern, name } of patterns) {
                    pattern += partPattern;
                    names.push({ name, exploded: part.exploded });
                }
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
            const value = match[i + 1]!;
            const cleanName = name.replace('*', '');

            result[cleanName] = exploded && value.includes(',') ? value.split(',') : value;
        }

        return result;
    }
}
