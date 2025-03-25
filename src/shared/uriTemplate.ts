// Claude-authored implementation of RFC 6570 URI Templates

export type Variables = Record<string, string | string[]>;

const MAX_TEMPLATE_LENGTH = 1000000; // 1MB
const MAX_VARIABLE_LENGTH = 1000000; // 1MB
const MAX_TEMPLATE_EXPRESSIONS = 10000;
const MAX_REGEX_LENGTH = 1000000; // 1MB

export class UriTemplate {
  /**
   * Returns true if the given string contains any URI template expressions.
   * A template expression is a sequence of characters enclosed in curly braces,
   * like {foo} or {?bar}.
   */
  static isTemplate(str: string): boolean {
    // Look for any sequence of characters between curly braces
    // that isn't just whitespace
    return /\{[^}\s]+\}/.test(str);
  }

  private static validateLength(
    str: string,
    max: number,
    context: string,
  ): void {
    if (str.length > max) {
      throw new Error(
        `${context} exceeds maximum length of ${max} characters (got ${str.length})`,
      );
    }
  }
  private readonly template: string;
  private readonly parts: Array<
    | string
    | { name: string; operator: string; names: string[]; exploded: boolean }
  >;

  constructor(template: string) {
    UriTemplate.validateLength(template, MAX_TEMPLATE_LENGTH, "Template");
    this.template = template;
    this.parts = this.parse(template);
  }

  toString(): string {
    return this.template;
  }

  private parse(
    template: string,
  ): Array<
    | string
    | { name: string; operator: string; names: string[]; exploded: boolean }
  > {
    const parts: Array<
      | string
      | { name: string; operator: string; names: string[]; exploded: boolean }
    > = [];
    let currentText = "";
    let i = 0;
    let expressionCount = 0;

    while (i < template.length) {
      if (template[i] === "{") {
        if (currentText) {
          parts.push(currentText);
          currentText = "";
        }
        const end = template.indexOf("}", i);
        if (end === -1) throw new Error("Unclosed template expression");

        expressionCount++;
        if (expressionCount > MAX_TEMPLATE_EXPRESSIONS) {
          throw new Error(
            `Template contains too many expressions (max ${MAX_TEMPLATE_EXPRESSIONS})`,
          );
        }

        const expr = template.slice(i + 1, end);
        const operator = this.getOperator(expr);
        const exploded = expr.includes("*");
        const names = this.getNames(expr);
        const name = names[0];

        // Validate variable name length
        for (const name of names) {
          UriTemplate.validateLength(
            name,
            MAX_VARIABLE_LENGTH,
            "Variable name",
          );
        }

        parts.push({ name, operator, names, exploded });
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
    const operators = ["+", "#", ".", "/", "?", "&"];
    return operators.find((op) => expr.startsWith(op)) || "";
  }

  private getNames(expr: string): string[] {
    const operator = this.getOperator(expr);
    return expr
      .slice(operator.length)
      .split(",")
      .map((name) => name.replace("*", "").trim())
      .filter((name) => name.length > 0);
  }

  private encodeValue(value: string, operator: string): string {
    UriTemplate.validateLength(value, MAX_VARIABLE_LENGTH, "Variable value");
    if (operator === "+" || operator === "#") {
      return encodeURI(value);
    }
    return encodeURIComponent(value);
  }

  private expandPart(
    part: {
      name: string;
      operator: string;
      names: string[];
      exploded: boolean;
    },
    variables: Variables,
  ): string {
    if (part.operator === "?" || part.operator === "&") {
      const pairs = part.names
        .map((name) => {
          const value = variables[name];
          if (value === undefined) return "";
          const encoded = Array.isArray(value)
            ? value.map((v) => this.encodeValue(v, part.operator)).join(",")
            : this.encodeValue(value.toString(), part.operator);
          return `${name}=${encoded}`;
        })
        .filter((pair) => pair.length > 0);

      if (pairs.length === 0) return "";
      const separator = part.operator === "?" ? "?" : "&";
      return separator + pairs.join("&");
    }

    if (part.names.length > 1) {
      const values = part.names
        .map((name) => variables[name])
        .filter((v) => v !== undefined);
      if (values.length === 0) return "";
      return values.map((v) => (Array.isArray(v) ? v[0] : v)).join(",");
    }

    const value = variables[part.name];
    if (value === undefined) return "";

    const values = Array.isArray(value) ? value : [value];
    const encoded = values.map((v) => this.encodeValue(v, part.operator));

    switch (part.operator) {
      case "":
        return encoded.join(",");
      case "+":
        return encoded.join(",");
      case "#":
        return "#" + encoded.join(",");
      case ".":
        return "." + encoded.join(".");
      case "/":
        return "/" + encoded.join("/");
      default:
        return encoded.join(",");
    }
  }

  expand(variables: Variables): string {
    let result = "";
    let hasQueryParam = false;

    for (const part of this.parts) {
      if (typeof part === "string") {
        result += part;
        continue;
      }

      const expanded = this.expandPart(part, variables);
      if (!expanded) continue;

      // Convert ? to & if we already have a query parameter
      if ((part.operator === "?" || part.operator === "&") && hasQueryParam) {
        result += expanded.replace("?", "&");
      } else {
        result += expanded;
      }

      if (part.operator === "?" || part.operator === "&") {
        hasQueryParam = true;
      }
    }

    return result;
  }

  private escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private partToRegExp(part: {
    name: string;
    operator: string;
    names: string[];
    exploded: boolean;
  }): Array<{ pattern: string; name: string }> {
    const patterns: Array<{ pattern: string; name: string }> = [];

    // Validate variable name length for matching
    for (const name of part.names) {
      UriTemplate.validateLength(name, MAX_VARIABLE_LENGTH, "Variable name");
    }

    if (part.operator === "?" || part.operator === "&") {
      for (let i = 0; i < part.names.length; i++) {
        const name = part.names[i];
        const prefix = i === 0 ? "\\" + part.operator : "&";
        patterns.push({
          pattern: prefix + this.escapeRegExp(name) + "=([^&]+)",
          name,
        });
      }
      return patterns;
    }

    let pattern: string;
    const name = part.name;

    switch (part.operator) {
      case "":
        pattern = part.exploded ? "([^/]+(?:,[^/]+)*)" : "([^/,]+)";
        break;
      case "+":
      case "#":
        pattern = "(.+)";
        break;
      case ".":
        pattern = "\\.([^/,]+)";
        break;
      case "/":
        pattern = "/" + (part.exploded ? "([^/]+(?:,[^/]+)*)" : "([^/,]+)");
        break;
      default:
        pattern = "([^/]+)";
    }

    patterns.push({ pattern, name });
    return patterns;
  }

  match(uri: string): Variables | null {
    UriTemplate.validateLength(uri, MAX_TEMPLATE_LENGTH, "URI");
    let pattern = "^";
    const names: Array<{ name: string; exploded: boolean }> = [];

    for (const part of this.parts) {
      if (typeof part === "string") {
        pattern += this.escapeRegExp(part);
      } else {
        const patterns = this.partToRegExp(part);
        for (const { pattern: partPattern, name } of patterns) {
          pattern += partPattern;
          names.push({ name, exploded: part.exploded });
        }
      }
    }

    pattern += "$";
    UriTemplate.validateLength(
      pattern,
      MAX_REGEX_LENGTH,
      "Generated regex pattern",
    );
    const regex = new RegExp(pattern);
    const match = uri.match(regex);

    if (!match) return null;

    const result: Variables = {};
    for (let i = 0; i < names.length; i++) {
      const { name, exploded } = names[i];
      const value = match[i + 1];
      const cleanName = name.replace("*", "");

      if (exploded && value.includes(",")) {
        result[cleanName] = value.split(",");
      } else {
        result[cleanName] = value;
      }
    }

    return result;
  }
}
