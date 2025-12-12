import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';

// Shared Zod namespace type that exposes the common surface area used in tests.
export type ZNamespace = typeof z3 & typeof z4;

export const zodTestMatrix = [
    {
        zodVersionLabel: 'Zod v3',
        z: z3 as ZNamespace,
        isV3: true as const,
        isV4: false as const
    },
    {
        zodVersionLabel: 'Zod v4',
        z: z4 as ZNamespace,
        isV3: false as const,
        isV4: true as const
    }
] as const;

export type ZodMatrixEntry = (typeof zodTestMatrix)[number];
