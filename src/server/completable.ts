import {
  z,
} from "zod";

export type CompleteCallback<T extends z.core.SomeType = z.core.SomeType> = (
  value: z.input<T>,
  context?: {
    arguments?: Record<string, string>;
  },
) => z.output<T>[] | Promise<z.output<T>[]>;

export interface $CompletableDef<T extends z.core.SomeType = z.core.$ZodType> extends z.core.$ZodTypeDef {
  type: "custom";
  innerType: T;
  complete: CompleteCallback<T>;
}

export interface $CompletableInternals<T extends z.core.SomeType = z.core.$ZodType>
  extends z.core.$ZodTypeInternals<z.core.output<T>, z.core.input<T>> {
  def: $CompletableDef<T>;
  isst: never;
  /** Auto-cached way to retrieve the inner schema */
  innerType: T;
  pattern: T["_zod"]["pattern"];
  propValues: T["_zod"]["propValues"];
  optin: T["_zod"]["optin"];
  optout: T["_zod"]["optout"];
}

export interface $Completable<T extends z.core.SomeType = z.core.$ZodType> extends z.core.$ZodType {
  _zod: $CompletableInternals<T>;
}

export const $Completable: z.core.$constructor<$Completable> = /*@__PURE__*/ z.core.$constructor("$Completable", (inst, def) => {
  z.core.$ZodType.init(inst, def);

  z.util.defineLazy(inst._zod, "innerType", () => inst._zod.innerType);
  z.util.defineLazy(inst._zod, "pattern", () => inst._zod.innerType._zod.pattern);
  z.util.defineLazy(inst._zod, "propValues", () => inst._zod.innerType._zod.propValues);
  z.util.defineLazy(inst._zod, "optin", () => inst._zod.innerType._zod.optin ?? undefined);
  z.util.defineLazy(inst._zod, "optout", () => inst._zod.innerType._zod.optout ?? undefined);
  
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});


// Completable
export interface Completable<T extends z.core.SomeType = z.core.$ZodType>
  extends z._ZodType<$CompletableInternals<T>>,
    $Completable<T> {
  complete: CompleteCallback<T>;
}
export const Completable: z.core.$constructor<Completable> = /*@__PURE__*/ z.core.$constructor("Completable", (inst, def) => {
  $Completable.init(inst, def);
  z.ZodType.init(inst, def);

  inst.complete = def.complete;
});

export function completable<T extends z.ZodType>(
  schema: T,
  complete: CompleteCallback<T>,
): Completable<T> {
  return new Completable({
    type: "custom",
    innerType: schema,
    complete: complete,
  }) as Completable<T>;
}