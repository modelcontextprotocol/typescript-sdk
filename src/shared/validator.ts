/**
 * Interface for schema validators to enable pluggable validation strategies.
 * This abstraction allows the SDK to work in different environments,
 * including edge runtimes that prohibit dynamic code generation.
 */
export interface SchemaValidator {
  /**
   * Compiles a JSON Schema and returns a validation function.
   * @param schema The JSON Schema to compile
   * @returns A function that validates data against the compiled schema
   */
  compile(schema: unknown): ValidateFunction;

  /**
   * Formats validation errors into a human-readable string.
   * @param errors Array of validation errors, or null/undefined
   * @returns A formatted error message string
   */
  errorsText(errors?: ErrorObject[] | null): string;
}

/**
 * Function returned by SchemaValidator.compile() that validates data against a schema.
 */
export interface ValidateFunction {
  /**
   * Validates data against the compiled schema.
   * @param data The data to validate
   * @returns true if valid, false otherwise
   */
  (data: unknown): boolean;

  /**
   * Array of validation errors from the last validation.
   * Will be null/undefined if the last validation passed.
   */
  errors?: ErrorObject[] | null;
}

/**
 * Represents a validation error.
 */
export interface ErrorObject {
  /**
   * JSON Pointer to the location in the data where the error occurred.
   * Empty string refers to the root.
   */
  instancePath: string;

  /**
   * The validation error message.
   */
  message?: string;

  /**
   * The keyword that failed validation.
   */
  keyword?: string;

  /**
   * The schema path where the error occurred.
   */
  schemaPath?: string;

  /**
   * Additional parameters specific to the keyword.
   */
  params?: Record<string, unknown>;

  /**
   * The data that failed validation.
   */
  data?: unknown;
}