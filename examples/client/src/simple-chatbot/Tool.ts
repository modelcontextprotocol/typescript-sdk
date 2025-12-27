export interface ToolInit {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string | null;
  execution?: Record<string, unknown> | null;
}

export class Tool {
  public readonly name: string;
  public readonly description: string;
  public readonly inputSchema: Record<string, unknown>;
  public readonly title?: string | null;
  public readonly execution?: Record<string, unknown> | null;

  constructor(init: ToolInit) {
    this.name = init.name;
    this.description = init.description;
    this.inputSchema = init.inputSchema;
    this.title = init.title ?? null;
    this.execution = init.execution ?? null;
  }

  formatForLlm(): string {
    const props = this.inputSchema.properties ?? {};
    const required = Array.isArray(this.inputSchema?.required)
      ? (this.inputSchema.required as string[])
      : [];

    const args = Object.entries(props).map(([paramName, info]) => {
      const suffix = required.includes(paramName) ? ' (required)' : '';
      const description = (info as Record<string, unknown>)?.description as string ?? 'No description';
      return `- ${paramName}: ${description}${suffix}`;
    });

    let output = `Tool: ${this.name}\n`;
    if (this.title) {
      output += `User-readable title: ${this.title}\n`;
    }
    output += `Description: ${this.description}\nArguments:\n${args.join('\n')}\n`;
    return output;
  }
}
