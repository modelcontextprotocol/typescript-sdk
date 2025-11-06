import { ZodDefaultDef } from 'zod/v3';
import { JsonSchema7Type, parseDef } from '../parseDef.js';
import { Refs } from '../Refs.js';

export function parseDefaultDef(_def: ZodDefaultDef, refs: Refs): JsonSchema7Type & { default: any } {
  return {
    ...parseDef(_def.innerType._def, refs),
    default: _def.defaultValue(),
  };
}
