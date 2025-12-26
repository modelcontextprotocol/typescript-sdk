export interface ToolInit {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string | null;
}

export class Tool {
  public readonly name: string;
  public readonly description: string;
  public readonly inputSchema: Record<string, unknown>;
  public readonly title?: string | null;

  constructor(init: ToolInit) {
    this.name = init.name;
    this.description = init.description;
    this.inputSchema = init.inputSchema;
    this.title = init.title ?? null;
  }

  formatForLlm(): string {
    throw new Error('Not implemented');
  }
}
