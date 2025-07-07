import { SchemaValidator, ValidateFunction, ErrorObject } from "../validator.js";

/**
 * Example edge-compatible schema validator using @cfworker/json-schema.
 * This validator works in Cloudflare Workers and other edge runtimes
 * that prohibit dynamic code generation (eval/new Function).
 * 
 * Note: This is provided as an example. Users should install
 * @cfworker/json-schema separately if they want to use this validator.
 * 
 * @example
 * ```typescript
 * import { Validator } from "@cfworker/json-schema";
 * import { Client } from "@modelcontextprotocol/sdk/client.js";
 * 
 * const client = new Client(
 *   { name: "my-client", version: "1.0.0" },
 *   { validator: new CFWorkerValidator() }
 * );
 * ```
 */
export class CFWorkerValidator implements SchemaValidator {
  compile(schema: unknown): ValidateFunction {
    // This is a mock implementation showing the interface.
    // In a real implementation, you would:
    // 1. Import { Validator } from "@cfworker/json-schema"
    // 2. Create a new Validator instance with the schema
    // 3. Return a ValidateFunction that uses the validator
    
    // For now, we'll throw an error indicating the dependency is needed
    throw new Error(
      "CFWorkerValidator requires @cfworker/json-schema to be installed. " +
      "Install it with: npm install @cfworker/json-schema"
    );
    
    // Real implementation would look like:
    /*
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
    */
  }

  errorsText(errors?: ErrorObject[] | null): string {
    if (!errors || errors.length === 0) {
      return "No errors";
    }
    
    return errors
      .map(err => {
        const path = err.instancePath || "root";
        return `${path}: ${err.message}`;
      })
      .join("; ");
  }
}