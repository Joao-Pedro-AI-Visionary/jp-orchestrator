import { durableConfig, DurableConfigError } from './durable.config';

const KEY = `publickeyv1_${'a'.repeat(40)}`;

describe('durableConfig (DURABLE_RUNTIME)', () => {
  it('defaults to the journal runtime', () => {
    expect(durableConfig({})).toEqual({ runtime: 'journal' });
    expect(durableConfig({ DURABLE_RUNTIME: ' journal ' })).toEqual({ runtime: 'journal' });
  });

  it('restate: reads the ingress, endpoint, admin and identity settings with defaults', () => {
    const cfg = durableConfig({
      DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'http://restate:8080/', RESTATE_ADMIN_URL: 'http://restate:9070',
      RESTATE_IDENTITY_KEYS: `${KEY}, ${KEY}`, NODE_ENV: 'production',
    });
    expect(cfg).toEqual({
      runtime: 'restate',
      restate: {
        ingressUrl: 'http://restate:8080', endpointPort: 9080, endpointHost: '0.0.0.0', adminUrl: 'http://restate:9070',
        deploymentUrl: 'http://localhost:9080', identityKeys: [KEY, KEY], registerForce: false, ingressToken: null, resumeWindowMs: 7 * 24 * 3_600_000, effectMaxAttempts: 3,
      },
    });
  });

  it('local dev may opt out of request signing and force the registration, never in production', () => {
    const cfg = durableConfig({ DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'http://r', RESTATE_ALLOW_UNSIGNED: 'true', RESTATE_REGISTER_FORCE: 'true' });
    expect(cfg).toMatchObject({ restate: { identityKeys: [], registerForce: true } });
  });

  const U = { RESTATE_ALLOW_UNSIGNED: 'true' };
  it.each([
    [{ DURABLE_RUNTIME: 'restate' }, /RESTATE_INGRESS_URL é obrigatório/],
    [{ DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'not a url' }, /RESTATE_INGRESS_URL não é uma URL válida/],
    [{ DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'ftp://restate' }, /deve ser http\(s\)/],
    [{ DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'http://r' }, /RESTATE_IDENTITY_KEYS é obrigatório/],
    [{ DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'http://r', ...U, NODE_ENV: 'production' }, /RESTATE_ALLOW_UNSIGNED não é aceito em produção/],
    [{ DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'http://r', RESTATE_IDENTITY_KEYS: KEY, RESTATE_REGISTER_FORCE: 'true', NODE_ENV: 'production' }, /RESTATE_REGISTER_FORCE/],
    [{ DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'http://r', ...U, RESTATE_ENDPOINT_PORT: '70000' }, /RESTATE_ENDPOINT_PORT/],
    [{ DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'http://r', RESTATE_IDENTITY_KEYS: 'segredo' }, /publickeyv1_/],
    [{ DURABLE_RUNTIME: 'restate', RESTATE_INGRESS_URL: 'http://r', ...U, RESTATE_RESUME_WINDOW_MS: '0' }, /RESTATE_RESUME_WINDOW_MS/],
    [{ DURABLE_RUNTIME: 'temporal' }, /temporal.*não está implementado/],
    [{ DURABLE_RUNTIME: 'cadence' }, /"cadence"/],
  ])('rejects a misconfiguration: %p', (env, message) => {
    expect(() => durableConfig(env)).toThrow(DurableConfigError);
    expect(() => durableConfig(env)).toThrow(message);
  });
});
