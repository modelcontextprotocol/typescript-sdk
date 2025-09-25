const fs = require('fs');

// Read the spec types file
const content = fs.readFileSync('spec.types.ts', 'utf8');

// Fix ElicitResult to use discriminated union like the SDK
const fixed = content.replace(
  /export interface ElicitResult extends Result \{[\s\S]*?content\?:[\s\S]*?\}/,
  `export type ElicitResult = 
  | (Result & {
      /**
       * User accepted and submitted the form.
       */
      action: "accept";
      /**
       * The submitted form data matching the requested schema.
       */
      content: { [key: string]: string | number | boolean };
    })
  | (Result & {
      /**
       * User explicitly declined or dismissed the request.
       */
      action: "decline" | "cancel";
      /**
       * Optional content, typically omitted for decline/cancel.
       */
      content?: any;
    });`
);

// Write the fixed content back
fs.writeFileSync('spec.types.ts', fixed);
console.log('Fixed ElicitResult type in spec.types.ts to match SDK discriminated union');