import { ZodEffectsDef } from 'zod/v3';
import { JsonSchema7Type, parseDef } from '../parseDef.js';
import { Refs } from '../Refs.js';

export function parseEffectsDef(
  _def: ZodEffectsDef,
  refs: Refs,
  forceResolution: boolean,
): JsonSchema7Type | undefined {
  return refs.effectStrategy === 'input' ? parseDef(_def.schema._def, refs, forceResolution) : {};
}
