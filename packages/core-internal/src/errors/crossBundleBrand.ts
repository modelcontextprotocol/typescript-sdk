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
 * A class participates by defining an **own** `mcpBrand` static (via a `static {}`
 * block, so nothing reaches the declaration files — a declared `protected static`
 * field would make the constructor types nominally incompatible across the bundled
 * copies) and (for hierarchy roots) installing {@linkcode brandedHasInstance} as
 * `Symbol.hasInstance`. User-defined subclasses that do not declare their own brand
 * keep plain prototype semantics — a foreign base-class instance never satisfies
 * `instanceof UserSubclass`.
 *
 * Contract notes:
 * - Brands assert **identity, not shape**: brand strings are version-less, so an
 *   instance from one SDK version matches the class of another. Members added to a
 *   branded class in a later version may be absent on a matched instance — read
 *   fields defensively, and treat branded classes as additive-only.
 * - Cross-bundle matching requires **both** copies to be at or after the release
 *   that introduced branding; against an older copy, behavior degrades to plain
 *   prototype `instanceof` in both directions.
 * - A consumer re-bundling the SDK with property mangling (`mangle.props`) would
 *   break the brand statics; default esbuild/webpack/terser settings do not.
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
 *
 * Constructor-time only: never stamp arbitrary objects. A stamped non-instance would
 * satisfy `instanceof` while lacking the prototype members (getters like `.status`)
 * that callers reach for after the check.
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
    try {
        if (
            typeof value === 'object' &&
            value !== null &&
            Object.prototype.hasOwnProperty.call(cls, 'mcpBrand') &&
            typeof (cls as BrandedConstructor).mcpBrand === 'string' &&
            // Own-property only: a brand inherited via the prototype chain is never
            // honored, so polluting Object.prototype with the registry symbol cannot
            // make arbitrary objects satisfy instanceof (real instances are stamped
            // with an own property by stampErrorBrands).
            Object.prototype.hasOwnProperty.call(value, BRANDS)
        ) {
            const carried = (value as BrandCarrier)[BRANDS];
            if (carried && typeof carried.has === 'function' && carried.has((cls as BrandedConstructor).mcpBrand!)) {
                return true;
            }
        }
    } catch {
        // A hostile Proxy trap or throwing accessor must not make `instanceof`
        // throw where it previously returned false — fall through to the
        // ordinary prototype check.
    }
    return Function.prototype[Symbol.hasInstance].call(cls, value);
}
