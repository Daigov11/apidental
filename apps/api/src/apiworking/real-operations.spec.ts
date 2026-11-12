import type { AppConfig } from '../config/app-config.js';
import type { PrismaDb } from '../prisma/client.js';
import { enforceRealOperationsCap } from './real-operations.js';

const db = (sales: number, other: number) => ({ apiworkingSale: { count: async () => sales }, auditLog: { count: async () => other } }) as unknown as PrismaDb;
const config = (max: number) => ({ apiworking: { maxRealOperations: max, expectedDatabase: 'prod_ti_x' } }) as unknown as AppConfig;

describe('enforceRealOperationsCap', () => {
  it('sin tope (0) no bloquea nunca', async () => {
    await expect(enforceRealOperationsCap(db(500, 500), config(0))).resolves.toBeUndefined();
  });
  it('con tope bloquea al alcanzarlo, sumando ventas y demás envíos', async () => {
    await expect(enforceRealOperationsCap(db(2, 1), config(4))).resolves.toBeUndefined();
    await expect(enforceRealOperationsCap(db(2, 2), config(4))).rejects.toMatchObject({ response: { code: 'REAL_OPERATIONS_LIMIT' } });
  });
});
