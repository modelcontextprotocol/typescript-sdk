import * as z4 from 'zod/v4';

// Zod namespace type for tests
export type ZNamespace = typeof z4;

export const zodTestMatrix = [
    {
        zodVersionLabel: 'Zod v4',
        z: z4 as ZNamespace
    }
] as const;

export type ZodMatrixEntry = (typeof zodTestMatrix)[number];
