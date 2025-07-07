import Ajv from "ajv";
import type { ErrorObject as AjvErrorObject } from "ajv";
import { SchemaValidator, ValidateFunction, ErrorObject } from "../validator.js";

/**
 * Default schema validator implementation using AJV v6.
 * This validator uses dynamic code generation for performance,
 * which makes it incompatible with edge runtimes like Cloudflare Workers.
 */
export class AjvValidator implements SchemaValidator {
  private ajv: InstanceType<typeof Ajv>;

  constructor() {
    this.ajv = new Ajv();
  }

  compile(schema: unknown): ValidateFunction {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ajvValidate = this.ajv.compile(schema as any);
    
    // Create a wrapper function that maintains the same interface
    const validate: ValidateFunction = (data: unknown): boolean => {
      const result = ajvValidate(data);
      
      // Copy errors to our wrapper function
      if (!result && ajvValidate.errors) {
        validate.errors = this.mapAjvErrors(ajvValidate.errors);
      } else {
        validate.errors = null;
      }
      
      return result as boolean;
    };

    return validate;
  }

  errorsText(errors?: ErrorObject[] | null): string {
    if (!errors || errors.length === 0) {
      return "No errors";
    }
    
    // Convert back to AJV error format for consistent formatting
    const ajvErrors = errors.map(err => ({
      dataPath: err.instancePath, // AJV v6 uses dataPath
      schemaPath: err.schemaPath || "",
      keyword: err.keyword || "",
      params: err.params || {},
      message: err.message,
      data: err.data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    
    return this.ajv.errorsText(ajvErrors);
  }

  /**
   * Maps AJV error objects to our generic error interface.
   */
  private mapAjvErrors(ajvErrors: AjvErrorObject[]): ErrorObject[] {
    return ajvErrors.map(err => ({
      instancePath: err.dataPath || "", // AJV v6 uses dataPath
      message: err.message,
      keyword: err.keyword,
      schemaPath: err.schemaPath,
      params: err.params as Record<string, unknown>,
      data: err.data
    }));
  }
}