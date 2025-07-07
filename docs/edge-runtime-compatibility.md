# Edge Runtime Compatibility

The MCP TypeScript SDK uses JSON Schema validation which requires dynamic code generation (`eval()` and `new Function()`) in its default implementation. This makes it incompatible with edge runtimes like Cloudflare Workers that prohibit these operations for security reasons.

## The Problem

When running in Cloudflare Workers or similar edge environments, you'll encounter:

```
EvalError: Code generation from strings disallowed for this context
```

This happens because the default AJV validator compiles schemas into JavaScript code at runtime.

## The Solution: Validator Abstraction

The SDK now provides a validator abstraction that allows you to supply your own edge-compatible validator:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client.js";
import { Server } from "@modelcontextprotocol/sdk/server.js";

// Create a custom validator (see options below)
const edgeValidator = new MyEdgeValidator();

// Use it with the client
const client = new Client(
  { name: "my-client", version: "1.0.0" },
  { validator: edgeValidator }
);

// Or with the server
const server = new Server(
  { name: "my-server", version: "1.0.0" },
  { validator: edgeValidator }
);
```

## Edge-Compatible Validator Options

### Option 1: @cfworker/json-schema

The `@cfworker/json-schema` library provides JSON Schema validation without code generation:

```typescript
import { Validator } from "@cfworker/json-schema";
import { SchemaValidator, ValidateFunction, ErrorObject } from "@modelcontextprotocol/sdk/shared/validator.js";

class CFWorkerValidator implements SchemaValidator {
  compile(schema: unknown): ValidateFunction {
    const validator = new Validator(schema as any);
    
    const validate: ValidateFunction = (data: unknown): boolean => {
      const result = validator.validate(data);
      
      if (!result.valid && result.errors) {
        validate.errors = result.errors.map(err => ({
          instancePath: err.instancePath || "",
          message: err.error,
          keyword: err.keyword,
          schemaPath: err.schemaPath
        }));
      } else {
        validate.errors = null;
      }
      
      return result.valid;
    };
    
    return validate;
  }

  errorsText(errors?: ErrorObject[] | null): string {
    if (!errors || errors.length === 0) return "No errors";
    return errors.map(e => `${e.instancePath}: ${e.message}`).join("; ");
  }
}
```

### Option 2: No Validation

If you trust your data or validate it elsewhere, you can skip validation:

```typescript
class NoOpValidator implements SchemaValidator {
  compile(schema: unknown): ValidateFunction {
    const validate: ValidateFunction = (data: unknown): boolean => true;
    validate.errors = null;
    return validate;
  }

  errorsText(errors?: ErrorObject[] | null): string {
    return "No errors";
  }
}
```

### Option 3: Pre-compiled Validators

For known schemas, you can pre-compile validators at build time:

```typescript
// Build time: Generate validator code
import Ajv from "ajv/dist/standalone";
import standaloneCode from "ajv/dist/standalone/index.js";

const ajv = new Ajv({ code: { source: true } });
const schema = { type: "object", properties: { name: { type: "string" } } };
const validate = ajv.compile(schema);
const moduleCode = standaloneCode(ajv, validate);

// Save to validators/my-schema.js
```

Then use the pre-compiled validator at runtime without eval.

## Performance Considerations

- **AJV (default)**: Fastest runtime performance, uses code generation
- **@cfworker/json-schema**: Slower but works in all environments
- **Pre-compiled**: Fast runtime, larger bundle size, requires build step

## Migration Guide

1. **Install edge-compatible validator** (if using Option 1):
   ```bash
   npm install @cfworker/json-schema
   ```

2. **Create validator instance**:
   ```typescript
   import { CFWorkerValidator } from "./validators/cfworker-validator.js";
   const validator = new CFWorkerValidator();
   ```

3. **Pass to Client/Server**:
   ```typescript
   const client = new Client(clientInfo, { validator });
   const server = new Server(serverInfo, { validator });
   ```

## Testing in Edge Environments

To test your edge-compatible setup:

```typescript
// wrangler.toml
name = "mcp-edge-test"
main = "src/worker.ts"
compatibility_date = "2024-01-01"

// src/worker.ts
import { Client } from "@modelcontextprotocol/sdk/client.js";
import { CFWorkerValidator } from "./cfworker-validator.js";

export default {
  async fetch(request: Request): Promise<Response> {
    const client = new Client(
      { name: "edge-client", version: "1.0.0" },
      { validator: new CFWorkerValidator() }
    );
    
    // Your edge logic here
    return new Response("MCP client running in edge!");
  }
};
```

## Backward Compatibility

The validator abstraction is fully backward compatible:

- If no validator is provided, the SDK uses AJV v6 (current behavior)
- Existing code continues to work without changes
- The validator option is optional

## Future Enhancements

We're exploring:

- Official edge-compatible validator package
- Build tools for schema pre-compilation
- Performance optimizations for edge validators

## References

- [Cloudflare Workers Compatibility](https://developers.cloudflare.com/workers/platform/compatibility/)
- [@cfworker/json-schema](https://github.com/cfworker/cfworker/tree/main/packages/json-schema)
- [AJV Standalone Code Generation](https://ajv.js.org/standalone.html)