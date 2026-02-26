---
title: Server Quickstart
---

# Quickstart: Build a weather server

In this tutorial, we'll build a simple MCP weather server and connect it to a host.

## What we'll be building

We'll build a server that exposes two tools: `get-alerts` and `get-forecast`. Then we'll connect the server to an MCP host (in this case, VS Code with GitHub Copilot).

## Core MCP Concepts

MCP servers can provide three main types of capabilities:

1. **[Resources](https://modelcontextprotocol.io/docs/learn/server-concepts#resources)**: File-like data that can be read by clients (like API responses or file contents)
2. **[Tools](https://modelcontextprotocol.io/docs/learn/server-concepts#tools)**: Functions that can be called by the LLM (with user approval)
3. **[Prompts](https://modelcontextprotocol.io/docs/learn/server-concepts#prompts)**: Pre-written templates that help users accomplish specific tasks

This tutorial will primarily focus on tools.

Let's get started with building our weather server! [You can find the complete code for what we'll be building here.](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/server-quickstart)

## Prerequisites

This quickstart assumes you have familiarity with:

- TypeScript
- LLMs like Claude

Make sure you have Node.js version 20 or higher installed. You can verify your installation:

```bash
node --version
npm --version
```

## Set up your environment

First, let's install Node.js and npm if you haven't already. You can download them from [nodejs.org](https://nodejs.org/).

Now, let's create and set up our project:

**macOS/Linux:**

```bash
# Create a new directory for our project
mkdir weather
cd weather

# Initialize a new npm project
npm init -y

# Install dependencies
npm install @modelcontextprotocol/server zod
npm install -D @types/node typescript

# Create our files
mkdir src
touch src/index.ts
```

**Windows:**

```powershell
# Create a new directory for our project
md weather
cd weather

# Initialize a new npm project
npm init -y

# Install dependencies
npm install @modelcontextprotocol/server zod
npm install -D @types/node typescript

# Create our files
md src
new-item src\index.ts
```

Update your `package.json` to add `type: "module"` and a build script:

```json
{
  "type": "module",
  "bin": {
    "weather": "./build/index.js"
  },
  "scripts": {
    "build": "tsc && chmod 755 build/index.js"
  },
  "files": ["build"]
}
```

Create a `tsconfig.json` in the root of your project:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

Now let's dive into building your server.

## Building your server

### Importing packages and setting up the instance

Add these to the top of your `src/index.ts`:

```ts source="../examples/server-quickstart/src/index.ts#prelude"
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const NWS_API_BASE = 'https://api.weather.gov';
const USER_AGENT = 'weather-app/1.0';

// Create server instance
const server = new McpServer({
  name: 'weather',
  version: '1.0.0',
});
```

### Helper functions

Next, let's add our helper functions for querying and formatting the data from the National Weather Service API:

```ts source="../examples/server-quickstart/src/index.ts#helpers"
// Helper function for making NWS API requests
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/geo+json',
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error('Error making NWS request:', error);
    return null;
  }
}

interface AlertFeature {
  properties: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    status?: string;
    headline?: string;
  };
}

// Format alert data
function formatAlert(feature: AlertFeature): string {
  const props = feature.properties;
  return [
    `Event: ${props.event || 'Unknown'}`,
    `Area: ${props.areaDesc || 'Unknown'}`,
    `Severity: ${props.severity || 'Unknown'}`,
    `Status: ${props.status || 'Unknown'}`,
    `Headline: ${props.headline || 'No headline'}`,
    '---',
  ].join('\n');
}

interface ForecastPeriod {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
}

interface AlertsResponse {
  features: AlertFeature[];
}

interface PointsResponse {
  properties: {
    forecast?: string;
  };
}

interface ForecastResponse {
  properties: {
    periods: ForecastPeriod[];
  };
}
```

### Registering tools

Each tool is registered with {@linkcode @modelcontextprotocol/server!server/mcp.McpServer#registerTool | server.registerTool()}, which takes the tool name, a configuration object (with description and input schema), and a callback that implements the tool logic. Let's register our two weather tools:

```ts source="../examples/server-quickstart/src/index.ts#registerTools"
// Register weather tools
server.registerTool(
  'get-alerts',
  {
    title: 'Get Weather Alerts',
    description: 'Get weather alerts for a state',
    inputSchema: z.object({
      state: z.string().length(2)
        .describe('Two-letter state code (e.g. CA, NY)'),
    }),
  },
  async ({ state }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

    if (!alertsData) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Failed to retrieve alerts data',
        }],
      };
    }

    const features = alertsData.features || [];

    if (features.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No active alerts for ${stateCode}`,
        }],
      };
    }

    const formattedAlerts = features.map(formatAlert);

    return {
      content: [{
        type: 'text' as const,
        text: `Active alerts for ${stateCode}:\n\n${formattedAlerts.join('\n')}`,
      }],
    };
  },
);

server.registerTool(
  'get-forecast',
  {
    title: 'Get Weather Forecast',
    description: 'Get weather forecast for a location',
    inputSchema: z.object({
      latitude: z.number().min(-90).max(90)
        .describe('Latitude of the location'),
      longitude: z.number().min(-180).max(180)
        .describe('Longitude of the location'),
    }),
  },
  async ({ latitude, longitude }) => {
    // Get grid point data
    const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

    if (!pointsData) {
      return {
        content: [{
          type: 'text' as const,
          text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
        }],
      };
    }

    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Failed to get forecast URL from grid point data',
        }],
      };
    }

    // Get forecast data
    const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
    if (!forecastData) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Failed to retrieve forecast data',
        }],
      };
    }

    const periods = forecastData.properties?.periods || [];
    if (periods.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No forecast periods available',
        }],
      };
    }

    // Format forecast periods
    const formattedForecast = periods.map((period: ForecastPeriod) =>
      [
        `${period.name || 'Unknown'}:`,
        `Temperature: ${period.temperature || 'Unknown'}°${period.temperatureUnit || 'F'}`,
        `Wind: ${period.windSpeed || 'Unknown'} ${period.windDirection || ''}`,
        `${period.shortForecast || 'No forecast available'}`,
        '---',
      ].join('\n'),
    );

    return {
      content: [{
        type: 'text' as const,
        text: `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join('\n')}`,
      }],
    };
  },
);
```

### Running the server

Finally, implement the main function to run the server:

```ts source="../examples/server-quickstart/src/index.ts#main"
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Weather MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
```

> [!IMPORTANT]
> Always use `console.error()` instead of `console.log()` in stdio-based MCP servers. Standard output is reserved for JSON-RPC protocol messages, and writing to it with `console.log()` will corrupt the communication channel.

Make sure to run `npm run build` to build your server! This is a very important step in getting your server to connect.

Let's now test your server from an existing MCP host.

## Testing your server in VS Code

[VS Code](https://code.visualstudio.com/) with [GitHub Copilot](https://github.com/features/copilot) can discover and invoke MCP tools via agent mode. [Copilot Free](https://github.com/features/copilot/plans) is sufficient to follow along.

> [!NOTE]
> Servers can connect to any client. We've chosen VS Code here for simplicity, but we also have a guide on [building your own client](./client-quickstart.md) as well as a [list of other clients here](https://modelcontextprotocol.io/clients).

### Prerequisites

1. Install [VS Code](https://code.visualstudio.com/) (version 1.99 or later).
2. Install the **GitHub Copilot** extension from the VS Code Extensions marketplace.
3. Sign in to your GitHub account when prompted.

### Configure the MCP server

Create a `.vscode/mcp.json` file in your `weather` project root:

```json
{
  "servers": {
    "weather": {
      "type": "stdio",
      "command": "node",
      "args": ["./build/index.js"]
    }
  }
}
```

VS Code may prompt you to trust the MCP server when it detects this file. If prompted, confirm to start the server.

To verify, run **MCP: List Servers** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`). The `weather` server should show a running status.

### Use the tools

1. Open **Copilot Chat** (`Ctrl+Alt+I` / `Ctrl+Cmd+I`).
2. Select **Agent** mode from the mode selector at the top of the chat panel.
3. Click the **Tools** button to confirm `get-alerts` and `get-forecast` appear.
4. Try these prompts:
   - "What's the weather in Sacramento?"
   - "What are the active weather alerts in Texas?"

> [!NOTE]
> Since this is the US National Weather Service, the queries will only work for US locations.

## What's happening under the hood

When you ask a question:

1. The client sends your question to the LLM
2. The LLM analyzes the available tools and decides which one(s) to use
3. The client executes the chosen tool(s) through the MCP server
4. The results are sent back to the LLM
5. The LLM formulates a natural language response
6. The response is displayed to you

## Troubleshooting

<details>
<summary>VS Code integration issues</summary>

**Server not appearing or fails to start**

1. Verify you have VS Code 1.99 or later (`Help > About`) and that GitHub Copilot is installed.
2. Verify the server builds without errors: run `npm run build` in the `weather` directory.
3. Test it manually: run `node build/index.js` — the process should start and wait for input. Press `Ctrl+C` to exit.
4. Check the server logs: in **MCP: List Servers**, select the server and choose **Show Output**.
5. If the `node` command is not found, use the full path to the Node binary.

**Tools don't appear in Copilot Chat**

1. Confirm you're in **Agent** mode (not Ask or Edit mode).
2. Run **MCP: Reset Cached Tools** from the Command Palette, then recheck the **Tools** list.

</details>

<details>
<summary>Weather API issues</summary>

**Error: Failed to retrieve grid point data**

This usually means either:

1. The coordinates are outside the US
2. The NWS API is having issues
3. You're being rate limited

Fix:

- Verify you're using US coordinates
- Add a small delay between requests
- Check the NWS API status page

**Error: No active alerts for [STATE]**

This isn't an error - it just means there are no current weather alerts for that state. Try a different state or check during severe weather.

</details>

## Next steps

Now that your server is running locally, here are some ways to go further:

- [**Server guide**](./server.md) — Add resources, prompts, logging, error handling, and remote transports to your server.
- [**Example servers**](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/server) — Browse runnable examples covering OAuth, streaming, sessions, and more.
- [**FAQ**](./faq.md) — Troubleshoot common errors (Zod version conflicts, transport issues, etc.).
