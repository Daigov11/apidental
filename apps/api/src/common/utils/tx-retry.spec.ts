import { isTransientTxError, withTxRetry } from './tx-retry.js';

const deadlock = Object.assign(new Error('Raw query failed. Code: `1213`'), {
  code: 'P2010',
  meta: { driverAdapterError: { cause: { originalCode: '1213', kind: 'TransactionWriteConflict' } } },
});

describe('tx-retry', () => {
  it('reconoce P2034 y los deadlocks/esperas de bloqueo de consultas crudas, y nada más', () => {
    expect(isTransientTxError({ code: 'P2034' })).toBe(true);
    expect(isTransientTxError(deadlock)).toBe(true);
    expect(isTransientTxError({ code: 'P2010', message: 'Raw query failed. Code: `1205`. Message: `Lock wait timeout`' })).toBe(true);
    expect(isTransientTxError({ code: 'P2010', message: 'Raw query failed. Code: `1064`. Message: `syntax`' })).toBe(false);
    expect(isTransientTxError({ code: 'P2002' })).toBe(false);
    expect(isTransientTxError(new Error('x'))).toBe(false);
    expect(isTransientTxError(undefined)).toBe(false);
  });

  it('reintenta lo transitorio y propaga lo demás o al agotar los intentos', async () => {
    let calls = 0;
    expect(await withTxRetry(async () => (++calls < 3 ? Promise.reject(deadlock) : 'ok'))).toBe('ok');
    expect(calls).toBe(3);
    let other = 0;
    await expect(withTxRetry(() => { other++; return Promise.reject(new Error('boom')); })).rejects.toThrow('boom');
    expect(other).toBe(1);
    let always = 0;
    await expect(withTxRetry(() => { always++; return Promise.reject(deadlock); }, 3)).rejects.toBe(deadlock);
    expect(always).toBe(3);
  });
});
