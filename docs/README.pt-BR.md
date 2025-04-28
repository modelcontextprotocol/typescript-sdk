# MCP TypeScript SDK ![Versão no NPM](https://img.shields.io/npm/v/%40modelcontextprotocol%2Fsdk) ![Licença MIT](https://img.shields.io/npm/l/%40modelcontextprotocol%2Fsdk)

## Sumário

- [Visão Geral](#visão-geral)
- [Instalação](#instalação)
- [Início Rápido](#início-rápido)
- [O que é MCP?](#o-que-é-mcp)
- [Conceitos Principais](#conceitos-principais)
  - [Servidor](#servidor)
  - [Recursos](#recursos)
  - [Ferramentas](#ferramentas)
  - [Prompts](#prompts)
- [Executando Seu Servidor](#executando-seu-servidor)
  - [stdio](#stdio)
  - [HTTP Streamable](#http-streamable)
  - [Testes e Depuração](#testes-e-depuração)
- [Exemplos](#exemplos)
  - [Servidor Echo](#servidor-echo)
  - [Explorador SQLite](#explorador-sqlite)
- [Uso Avançado](#uso-avançado)
  - [Servidor de Baixo Nível](#servidor-de-baixo-nível)
  - [Escrevendo Clientes MCP](#escrevendo-clientes-mcp)
  - [Capacidades do Servidor](#capacidades-do-servidor)
  - [Servidor OAuth Proxy](#servidor-oauth-proxy)
  - [Compatibilidade Retroativa](#compatibilidade-retroativa)

## Visão Geral

O Model Context Protocol permite que aplicações forneçam contexto para LLMs de forma padronizada, separando as responsabilidades de disponibilizar contexto da interação com o LLM. Este SDK em TypeScript implementa toda a especificação MCP, facilitando:

- Construir clientes MCP que se conectam a qualquer servidor MCP
- Criar servidores MCP que expõem recursos, prompts e ferramentas
- Usar transportes padrão como stdio e HTTP Streamable
- Tratar todas as mensagens e eventos de ciclo de vida do protocolo MCP

## Instalação

```bash
npm install @modelcontextprotocol/sdk
```

## Início Rápido

Vamos criar um servidor MCP simples que expõe uma ferramenta de cálculo e um recurso de dados:

```typescript
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Cria o servidor MCP
const server = new McpServer({
  name: "Demo",
  version: "1.0.0",
});

// Adiciona a ferramenta de soma
server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));

// Adiciona um recurso dinâmico de saudação
server.resource(
  "greeting",
  new ResourceTemplate("greeting://{name}", { list: undefined }),
  async (uri, { name }) => ({
    contents: [
      {
        uri: uri.href,
        text: `Olá, ${name}!`,
      },
    ],
  })
);

// Inicia o transporte via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
```

## O que é MCP?

O [Model Context Protocol (MCP)](https://modelcontextprotocol.io) permite construir servidores que expõem dados e funcionalidades para aplicações LLM de forma segura e padronizada. Pense nele como uma API web especificamente desenhada para interações com LLMs. Servidores MCP podem:

- Expor dados através de **Recursos** (semelhantes a endpoints GET; usados para carregar contexto no LLM)
- Disponibilizar funcionalidades através de **Ferramentas** (semelhantes a endpoints POST; usados para executar código ou efeitos colaterais)
- Definir padrões de interação através de **Prompts** (modelos reutilizáveis para interação com LLM)
- E muito mais!

## Conceitos Principais

### Servidor

O `McpServer` é sua interface principal com o protocolo MCP. Ele gerencia conexões, conformidade com o protocolo e roteamento de mensagens:

```typescript
const server = new McpServer({
  name: "Meu App",
  version: "1.0.0",
});
```

### Recursos

Recursos expõem dados para LLMs. São similares a endpoints GET em uma API REST — fornecem informação sem ter efeitos colaterais significativos:

```typescript
// Recurso estático
server.resource("config", "config://app", async (uri) => ({
  contents: [{ uri: uri.href, text: "Configuração do app aqui" }],
}));

// Recurso dinâmico com parâmetros
server.resource(
  "user-profile",
  new ResourceTemplate("users://{userId}/profile", { list: undefined }),
  async (uri, { userId }) => ({
    contents: [{ uri: uri.href, text: `Dados de perfil do usuário ${userId}` }],
  })
);
```

### Ferramentas

Ferramentas permitem ações e efeitos colaterais. Ao contrário de recursos, são usadas para executar lógicas:

```typescript
// Ferramenta simples
server.tool(
  "calculate-bmi",
  { weightKg: z.number(), heightM: z.number() },
  async ({ weightKg, heightM }) => ({
    content: [{ type: "text", text: String(weightKg / (heightM * heightM)) }],
  })
);

// Ferramenta assíncrona com chamada externa
server.tool("fetch-weather", { city: z.string() }, async ({ city }) => {
  const response = await fetch(`https://api.weather.com/${city}`);
  const data = await response.text();
  return { content: [{ type: "text", text: data }] };
});
```

### Prompts

Prompts são modelos de mensagens que ajudam LLMs a interagir com seu servidor:

```typescript
server.prompt("review-code", { code: z.string() }, ({ code }) => ({
  messages: [
    {
      role: "user",
      content: {
        type: "text",
        text: `Por favor, revise este código:\n\n${code}`,
      },
    },
  ],
}));
```

## Executando Seu Servidor

MCP servidores em TypeScript precisam ser conectados a um transporte para se comunicar com clientes. Como você começa o servidor depende do tipo de transporte escolhido:

### stdio

Para ferramentas de linha de comando e integrações diretas:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "example-server", version: "1.0.0" });
// ... configura recursos, ferramentas e prompts ...
const transport = new StdioServerTransport();
await server.connect(transport);
```

### HTTP Streamable

Para servidores remotos, configure um transporte HTTP Streamable que lida com solicitações de cliente e notificações de servidor-para-cliente.

#### Com Gerenciamento de Sessão

Em alguns casos, servidores precisam ser estado. Isso é alcançado por [gerenciamento de sessão](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#session-management).

```typescript
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = new McpServer({ name: "example-server", version: "1.0.0" });
    // ... configura recursos, ferramentas e prompts ...
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (
  req: express.Request,
  res: express.Response
) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Session inválida ou ausente");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(3000);
```

#### Sem Gerenciamento de Sessão (Stateless)

Para casos mais simples onde o gerenciamento de sessão não é necessário:

```typescript
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const server = getServer();
    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Erro ao tratar requisição MCP:", error);
    if (!res.headersSent)
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Erro interno do servidor" },
        id: null,
      });
  }
});

app.get("/mcp", async (req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Método não permitido." },
      id: null,
    })
  );
});
app.delete("/mcp", async (req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Método não permitido." },
      id: null,
    })
  );
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor HTTP Streamable MCP ouvindo na porta ${PORT}`);
});
```

## Testes e Depuração

Para testar seu servidor, você pode usar o [MCP Inspector](https://github.com/modelcontextprotocol/inspector). Veja o README dele para mais informações.

## Exemplos

### Servidor Echo

Um servidor simples demonstrando recursos, ferramentas e prompts:

```typescript
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "Echo", version: "1.0.0" });

server.resource(
  "echo",
  new ResourceTemplate("echo://{message}", { list: undefined }),
  async (uri, { message }) => ({
    contents: [{ uri: uri.href, text: `Recurso echo: ${message}` }],
  })
);
```

### Explorador SQLite

Um exemplo mais complexo mostrando integração com banco de dados:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sqlite3 from "sqlite3";
import { promisify } from "util";
import { z } from "zod";

const server = new McpServer({
  name: "Explorador SQLite",
  version: "1.0.0",
});

// Helper to create DB connection
const getDb = () => {
  const db = new sqlite3.Database("database.db");
  return {
    all: promisify<string, any[]>(db.all.bind(db)),
    close: promisify(db.close.bind(db)),
  };
};

server.resource("schema", "schema://main", async (uri) => {
  const db = getDb();
  try {
    const tables = await db.all(
      "SELECT sql FROM sqlite_master WHERE type='table'"
    );
    return {
      contents: [
        {
          uri: uri.href,
          text: tables.map((t: { sql: string }) => t.sql).join("\n"),
        },
      ],
    };
  } finally {
    await db.close();
  }
});

server.tool("query", { sql: z.string() }, async ({ sql }) => {
  const db = getDb();
  try {
    const results = await db.all(sql);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  } finally {
    await db.close();
  }
});
```

## Uso Avançado

### Servidor de Baixo Nível

Para mais controle, você pode usar a classe Server diretamente:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "example-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      prompts: {},
    },
  }
);

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "example-prompt",
        description: "An example prompt template",
        arguments: [
          {
            name: "arg1",
            description: "Example argument",
            required: true,
          },
        ],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "example-prompt") {
    throw new Error("Unknown prompt");
  }
  return {
    description: "Example prompt",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Example prompt text",
        },
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Escrevendo Clientes MCP

O SDK fornece uma interface de cliente de alto nível:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.js"],
});

const client = new Client({
  name: "example-client",
  version: "1.0.0",
});

await client.connect(transport);

// List prompts
const prompts = await client.listPrompts();

// Get a prompt
const prompt = await client.getPrompt({
  name: "example-prompt",
  arguments: {
    arg1: "value",
  },
});

// List resources
const resources = await client.listResources();

// Read a resource
const resource = await client.readResource({
  uri: "file:///example.txt",
});

// Call a tool
const result = await client.callTool({
  name: "example-tool",
  arguments: {
    arg1: "value",
  },
});
```

### Servidor OAuth Proxy

Você pode proxy solicitações OAuth para um provedor de autorização externa:

```typescript
import express from "express";
import {
  ProxyOAuthServerProvider,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk";

const app = express();

const proxyProvider = new ProxyOAuthServerProvider({
  endpoints: {
    authorizationUrl: "https://auth.external.com/oauth2/v1/authorize",
    tokenUrl: "https://auth.external.com/oauth2/v1/token",
    revocationUrl: "https://auth.external.com/oauth2/v1/revoke",
  },
  verifyAccessToken: async (token) => {
    return {
      token,
      clientId: "123",
      scopes: ["openid", "email", "profile"],
    };
  },
  getClient: async (client_id) => {
    return {
      client_id,
      redirect_uris: ["http://localhost:3000/callback"],
    };
  },
});

app.use(
  mcpAuthRouter({
    provider: proxyProvider,
    issuerUrl: new URL("http://auth.external.com"),
    baseUrl: new URL("http://mcp.example.com"),
    serviceDocumentationUrl: new URL("https://docs.example.com/"),
  })
);
```

Esta configuração permite:

- Forward OAuth requests to an external provider
- Add custom token validation logic
- Manage client registrations
- Provide custom documentation URLs
- Maintain control over the OAuth flow while delegating to an external provider

### Compatibilidade Retroativa

Clientes e servidores com transporte StreamableHttp podem manter [compatibilidade retroativa](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#backwards-compatibility) com o transporte HTTP+SSE obsoleto (da versão 2024-11-05) da seguinte forma

#### Compatibilidade do Cliente

Para clientes que precisam trabalhar com ambos Streamable HTTP e clientes mais antigos SSE:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
let client: Client | undefined = undefined;
const baseUrl = new URL(url);
try {
  client = new Client({
    name: "streamable-http-client",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
  console.log("Connected using Streamable HTTP transport");
} catch (error) {
  // If that fails with a 4xx error, try the older SSE transport
  console.log(
    "Streamable HTTP connection failed, falling back to SSE transport"
  );
  client = new Client({
    name: "sse-client",
    version: "1.0.0",
  });
  const sseTransport = new SSEClientTransport(baseUrl);
  await client.connect(sseTransport);
  console.log("Connected using SSE transport");
}
```

#### Compatibilidade do Servidor

Para servidores que precisam suportar ambos Streamable HTTP e clientes mais antigos:

```typescript
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const server = new McpServer({
  name: "backwards-compatible-server",
  version: "1.0.0",
});

// ... set up server resources, tools, and prompts ...

const app = express();
app.use(express.json());

// Store transports for each session type
const transports = {
  streamable: {} as Record<string, StreamableHTTPServerTransport>,
  sse: {} as Record<string, SSEServerTransport>,
};

// Modern Streamable HTTP endpoint
app.all("/mcp", async (req, res) => {
  // Handle Streamable HTTP transport for modern clients
  // Implementation as shown in the "With Session Management" example
  // ...
});

// Legacy SSE endpoint for older clients
app.get("/sse", async (req, res) => {
  // Create SSE transport for legacy clients
  const transport = new SSEServerTransport("/messages", res);
  transports.sse[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports.sse[transport.sessionId];
  });

  await server.connect(transport);
});

// Legacy message endpoint for older clients
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.sse[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

app.listen(3000);
```

**Nota**: O transporte SSE agora é obsoleto em favor de Streamable HTTP. Novas implementações devem usar Streamable HTTP, e implementações SSE existentes devem planejar migrar.

## Documentação

- [Documentação do Protocolo Model Context](https://modelcontextprotocol.io)
- [Especificação MCP](https://spec.modelcontextprotocol.io)
- [Example Servers](https://github.com/modelcontextprotocol/servers)

## Contribuindo

Issues and pull requests are welcome on GitHub at https://github.com/modelcontextprotocol/typescript-sdk.

## Licença

This project is licensed under the MIT License—see the [LICENSE](LICENSE) file for details.
