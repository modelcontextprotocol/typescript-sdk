/**
 * Cross-bundle `instanceof` support for the SDK error classes.
 *
 * `@modelcontextprotocol/client` and `@modelcontextprotocol/server` each bundle their
 * own copy of `core-internal`, so an error constructed by one package fails a
 * prototype-identity `instanceof` against the same class re-exported by the other —
 * exactly the check a dual-role process (gateway, host, in-process test) writes.
 *
 * Instead of prototype identity, branded classes stamp every instance with the brand
 * strings of its class chain under a registry symbol (`Symbol.for`, shared across
 * bundles and realms), and resolve `instanceof` via `Symbol.hasInstance` against the
 * brand set. Ordinary prototype-based `instanceof` is kept as a fallback so behavior
 * is unchanged for anything unbranded.
 *
 * A class participates by declaring an **own** `static readonly mcpBrand` and (for
 * hierarchy roots) installing {@linkcode brandedHasInstance} as `Symbol.hasInstance`.
 * User-defined subclasses that do not declare their own brand keep plain prototype
 * semantics — a foreign base-class instance never satisfies `instanceof UserSubclass`.
 */

/** Registry symbol — identical across bundled copies and realms. */
const BRANDS: unique symbol = Symbol.for('mcp.sdk.errorBrands') as never;

interface BrandCarrier {
    [BRANDS]?: { has(brand: string): boolean };
}

interface BrandedConstructor {
    mcpBrand?: string;
}

/**
 * Stamp `instance` with the brand of every class in `ctor`'s chain that declares an
 * own `mcpBrand`. Call once from the hierarchy root's constructor with `new.target` —
 * subclasses inherit the stamping without touching their constructors.
 */
export function stampErrorBrands(instance: object, ctor: unknown): void {
    const brands = new Set<string>();
    let current: unknown = ctor;
    while (typeof current === 'function') {
        const brand = (current as BrandedConstructor).mcpBrand;
        if (Object.prototype.hasOwnProperty.call(current, 'mcpBrand') && typeof brand === 'string') {
            brands.add(brand);
        }
        current = Object.getPrototypeOf(current);
    }
    if (brands.size === 0) return;
    Object.defineProperty(instance, BRANDS, { value: brands, enumerable: false, configurable: true });
}

/**
 * `Symbol.hasInstance` implementation for branded hierarchy roots. Matches when the
 * value carries the **own** brand of the class being tested against (cross-bundle
 * path), falling back to ordinary prototype-based `instanceof` otherwise.
 */
export function brandedHasInstance(cls: object, value: unknown): boolean {
    if (
        typeof value === 'object' &&
        value !== null &&
        Object.prototype.hasOwnProperty.call(cls, 'mcpBrand') &&
        typeof (cls as BrandedConstructor).mcpBrand === 'string'
    ) {
        const carried = (value as BrandCarrier)[BRANDS];
        if (carried && typeof carried.has === 'function' && carried.has((cls as BrandedConstructor).mcpBrand!)) {
            return true;
        }
    }
    return Function.prototype[Symbol.hasInstance].call(cls, value);
}
