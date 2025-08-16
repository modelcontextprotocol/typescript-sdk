# Custom Context Feature Demo

This example demonstrates the **Custom Context** feature that allows MCP servers to inject contextual information (like user authentication, permissions, tenant data) into tool handlers.

## What is Custom Context?

Custom Context allows transport implementations to attach arbitrary data that will be available to all request handlers (tools, prompts, resources). This is essential for:

- **Authentication**: Pass user identity from API keys or MCP access tokens
- **Multi-tenancy**: Isolate data between different organizations
- **Permissions**: Enforce access control based on user roles
- **Request tracking**: Add request IDs for debugging and auditing

## Running the Demo

### 1. Start the Server

```bash
# From the typescript-sdk directory
npm run build
node dist/examples/server/customContextServer.js
```

The server will start on port 3000 and display available API keys for testing.

### 2. Start the Client

In a new terminal:

```bash
# From the typescript-sdk directory
node dist/examples/client/customContextClient.js
```

## Demo Walkthrough

### Step 1: Authenticate with an API Key

The server simulates a database of API keys that map to user contexts. Try authenticating as different users:

```bash
> auth alice
🔐 Authenticating with API key: sk-alice-admin...
✅ Connected to server
👤 Authenticated as: Alice Anderson
   Organization: TechCorp Industries
   Role: admin
   Permissions: 4 permission(s)
```

### Step 2: Get User Information

The `get_user` tool retrieves the authenticated user's information from the context:

```bash
[Alice Anderson]> whoami
🔍 Fetching user information from context...

User Profile:
{
  "userId": "user-001",
  "name": "Alice Anderson",
  "email": "alice@techcorp.com",
  "role": "admin",
  "organization": {
    "id": "org-techcorp",
    "name": "TechCorp Industries"
  },
  "permissions": ["read:all", "write:all", "delete:all", "admin:users"],
  "accountCreated": "2024-01-15T08:00:00Z",
  "lastActive": "2024-07-29T12:34:56Z"
}
```

### Step 3: Get Personalized Dashboard

The `dashboard` command uses the prompt feature to generate personalized content:

```bash
> auth alice
[Alice Anderson]> dashboard
📊 Getting brief dashboard...

Welcome back, Alice Anderson! You have access to 3 projects in TechCorp Industries.

[Alice Anderson]> dashboard detailed
📊 Getting detailed dashboard...

Dashboard for Alice Anderson

Organization: TechCorp Industries
Role: admin
Plan: enterprise
Projects: 3
Permissions: read:all, write:all, delete:all, admin:users
Member since: 2024-01-15T08:00:00Z

Your organization has 2 members and is on the enterprise plan.
```

### Step 4: Access User Profile Resource

The `profile` command demonstrates resource access with context:

```bash
> auth bob
[Bob Builder]> profile
📄 Reading user profile resource...

📄 Resource: user://profile/user-002
Type: application/json
Content:
{
  "user": {
    "id": "user-002",
    "name": "Bob Builder",
    "email": "bob@techcorp.com",
    "role": "developer",
    "createdAt": "2024-02-20T10:30:00Z"
  },
  "organization": {
    "id": "org-techcorp",
    "name": "TechCorp Industries",
    "plan": "enterprise",
    "memberCount": 2,
    "projectCount": 3
  },
  "permissions": [
    "read:code",
    "write:code",
    "read:docs",
    "write:docs"
  ],
  "apiKey": {
    "id": "sk-bob-dev-key",
    "lastUsed": "2025-08-14T16:12:57.561Z"
  }
}
```

## How It Works

### Server Side

1. **Authentication Extraction**: The server extracts authentication credentials from request headers
2. **Context Fetching**: Uses the credentials to fetch/validate user context
3. **Context Injection**: Calls `transport.setCustomContext(userContext)`
4. **Tool Access**: Tools receive context via `extra.customContext`

```typescript
// Example with API key (shown in demo)
const apiKey = request.headers.get('x-api-key');
const context = await fetchUserContextByApiKey(apiKey);
transport.setCustomContext(context);

// Example with MCP access token (OAuth flow)
const accessToken = request.headers.get('authorization')?.replace('Bearer ', '');
const context = await validateMcpAccessToken(accessToken);
transport.setCustomContext(context);

// In tool handlers (same regardless of auth method)
async (params, extra) => {
  const context = extra.customContext as UserContext;
  if (!context.permissions.includes('required:permission')) {
    return { content: [{ type: 'text', text: 'Access denied' }] };
  }
  // ... perform action
}
```

### Client Side

The client adds authentication credentials to all requests:

```typescript
// Example with API key (shown in demo)
const transport = new StreamableHTTPClientTransport({
  url: serverUrl,
  fetch: async (url, options) => {
    const headers = {
      ...options?.headers,
      'X-API-Key': apiKey,
    };
    return fetch(url, { ...options, headers });
  }
});

// Example with MCP access token (OAuth flow)
const transport = new StreamableHTTPClientTransport({
  url: serverUrl,
  fetch: async (url, options) => {
    const headers = {
      ...options?.headers,
      'Authorization': `Bearer ${mcpAccessToken}`,
    };
    return fetch(url, { ...options, headers });
  }
});
```

## Available Test Users

| User | API Key | Organization | Role | Key Permissions |
|------|---------|--------------|------|-----------------|
| Alice | sk-alice-admin-key | TechCorp | admin | All permissions |
| Bob | sk-bob-dev-key | TechCorp | developer | Code & docs access |
| Charlie | sk-charlie-user-key | StartupIO | user | Limited read/write |
| Dana | sk-dana-admin-key | StartupIO | admin | Org administration |

## Key Features Demonstrated

1. **Authentication**: Supports both API keys and MCP access tokens
2. **Tool Context**: `get_user` tool accesses user context
3. **Prompt Context**: `user-dashboard` prompt personalizes content based on context
4. **Resource Context**: `user-profile` resource returns context-aware data
5. **Multi-tenancy**: Data isolation between organizations
6. **Request Tracking**: Unique request IDs for auditing

## Real-World Applications

This pattern is essential for:

- **SaaS Applications**: Isolate customer data in multi-tenant systems
- **Enterprise Tools**: Enforce role-based permissions
- **API Services**: Track usage and enforce rate limits per user
- **Audit Logging**: Track who did what and when
- **Personalization**: Customize responses based on user preferences

## Code Structure

- `customContextServer.ts`: Server with API key authentication and context injection
- `customContextClient.ts`: Interactive REPL client that sends API keys
- Tool (`get_user`) demonstrates context access
- Prompt (`user-dashboard`) shows personalized content
- Resource (`user-profile`) returns user-specific data

## Next Steps

To integrate custom context in your own MCP server:

1. Define your context interface
2. Extract authentication info from requests (API keys, JWT tokens, etc.)
3. Call `transport.setCustomContext(context)` with user data
4. Access context in handlers via `extra.customContext`
5. Implement permission checking and data filtering based on context

The custom context feature enables building secure, multi-tenant MCP applications with proper authentication and authorization.