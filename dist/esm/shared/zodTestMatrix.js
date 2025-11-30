import * as z3 from 'zod/v3';
import * as z4 from 'zod/v4';
export const zodTestMatrix = [
    {
        zodVersionLabel: 'Zod v3',
        z: z3,
        isV3: true,
        isV4: false
    },
    {
        zodVersionLabel: 'Zod v4',
        z: z4,
        isV3: false,
        isV4: true
    }
];
//# sourceMappingURL=zodTestMatrix.js.map