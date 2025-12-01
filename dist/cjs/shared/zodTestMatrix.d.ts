import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';
export type ZNamespace = typeof z3 & typeof z4;
export declare const zodTestMatrix: readonly [{
    readonly zodVersionLabel: "Zod v3";
    readonly z: ZNamespace;
    readonly isV3: true;
    readonly isV4: false;
}, {
    readonly zodVersionLabel: "Zod v4";
    readonly z: ZNamespace;
    readonly isV3: false;
    readonly isV4: true;
}];
export type ZodMatrixEntry = (typeof zodTestMatrix)[number];
//# sourceMappingURL=zodTestMatrix.d.ts.map