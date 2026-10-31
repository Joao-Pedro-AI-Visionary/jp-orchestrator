import { sign, verify } from './signer';

describe('HMAC signer', () => {
  const body = JSON.stringify({ type: 'task.completed', id: 't1' });

  it('accepts a valid signature', () => {
    expect(verify('s3cret', body, sign('s3cret', body))).toBe(true);
  });

  it('rejects a tampered body, wrong secret, missing or stale header', () => {
    const h = sign('s3cret', body);
    expect(verify('s3cret', body + ' ', h)).toBe(false);
    expect(verify('other', body, h)).toBe(false);
    expect(verify('s3cret', body, undefined)).toBe(false);
    const old = sign('s3cret', body, Math.floor(Date.now() / 1000) - 3600);
    expect(verify('s3cret', body, old)).toBe(false);
  });
});
