import * as fs from 'node:fs';

import { config } from 'dotenv';
import { z } from 'zod';

const McpServersConfigSchema = z.object({
  mcpServers: z.record(z.object({
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string()).optional(),
  })),
});

export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;

export class Configuration {
    private api_key?: string;
    constructor() {
        Configuration.loadEnv();
        this.api_key = process.env["LLM_API_KEY"];
    }
    static loadEnv(): void {
        config();
    }

    static loadConfig(filePath: string): McpServersConfig {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return McpServersConfigSchema.parse(parsed);
    }

    get llmApiKey(): string {
        if (!this.api_key) throw new Error("LLM_API_KEY not found in environment variables");
        return this.api_key;
    }

 
}


// class Configuration:
//     """Manages configuration and environment variables for the MCP client."""

//     def __init__(self) -> None:
//         """Initialize configuration with environment variables."""
//         self.load_env()
//         self.api_key = os.getenv("LLM_API_KEY")

//     @staticmethod
//     def load_env() -> None:
//         """Load environment variables from .env file."""
//         load_dotenv()examples/client/src/simple-chatbot/Configuration.ts

//     @staticmethod
//     def load_config(file_path: str) -> dict[str, Any]:
//         """Load server configuration from JSON file.

//         Args:
//             file_path: Path to the JSON configuration file.

//         Returns:
//             Dict containing server configuration.

//         Raises:
//             FileNotFoundError: If configuration file doesn't exist.
//             JSONDecodeError: If configuration file is invalid JSON.
//         """
//         with open(file_path, "r") as f:
//             return json.load(f)

//     @property
//     def llm_api_key(self) -> str:
//         """Get the LLM API key.

//         Returns:
//             The API key as a string.

//         Raises:
//             ValueError: If the API key is not found in environment variables.
//         """
//         if not self.api_key:
//             raise ValueError("LLM_API_KEY not found in environment variables")
//         return self.api_key