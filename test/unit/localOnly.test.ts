import { describe, expect, it } from 'vitest';
import { checkEndpointUrl, inspectOllamaExposure, isLoopbackHost, isRemoteModel, LocalOnlyPolicy, LocalOnlyViolation } from '../../src/core/policy/localOnly';

describe('isLoopbackHost', () => {
  it('accepts loopback spellings', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
  });

  it('refuses everything else', () => {
    for (const h of ['0.0.0.0', '192.168.1.10', '10.0.0.1', '128.0.0.1', '127.0.0.256', 'example.com', 'localhost.evil.com', 'ollama.com', '::', '::2', '::ffff:192.168.0.1', '']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe('checkEndpointUrl', () => {
  it('accepts http(s) loopback URLs', () => {
    expect(checkEndpointUrl('http://127.0.0.1:11434').ok).toBe(true);
    expect(checkEndpointUrl('http://localhost:1234/v1').ok).toBe(true);
    expect(checkEndpointUrl('https://[::1]:8080').ok).toBe(true);
  });

  it('refuses remote hosts, other protocols and credentials', () => {
    expect(checkEndpointUrl('http://192.168.1.20:11434').ok).toBe(false);
    expect(checkEndpointUrl('https://api.openai.com/v1').ok).toBe(false);
    expect(checkEndpointUrl('ftp://127.0.0.1').ok).toBe(false);
    expect(checkEndpointUrl('http://user:pass@127.0.0.1:11434').ok).toBe(false);
    expect(checkEndpointUrl('not a url').ok).toBe(false);
  });

  it('is not fooled by userinfo tricks', () => {
    // The real host here is evil.com.
    expect(checkEndpointUrl('http://127.0.0.1@evil.com:11434').ok).toBe(false);
    expect(checkEndpointUrl('http://evil.com#@127.0.0.1').ok).toBe(false);
  });
});

describe('LocalOnlyPolicy', () => {
  it('throws on non-loopback URLs before any request', () => {
    const policy = new LocalOnlyPolicy();
    expect(() => policy.assertAllowed('http://10.0.0.5:11434/api/tags')).toThrow(LocalOnlyViolation);
    expect(() => policy.assertAllowed('http://127.0.0.1:11434/api/tags')).not.toThrow();
  });

  it('checks that names resolve to loopback only', async () => {
    const good = new LocalOnlyPolicy(async () => ['127.0.0.1', '::1']);
    expect((await good.verifyEndpoint('http://localhost:11434')).ok).toBe(true);
    const tampered = new LocalOnlyPolicy(async () => ['93.184.216.34']);
    const verdict = await tampered.verifyEndpoint('http://localhost:11434');
    expect(verdict.ok).toBe(false);
  });

  it('does not resolve literal addresses', async () => {
    let called = false;
    const policy = new LocalOnlyPolicy(async () => {
      called = true;
      return [];
    });
    expect((await policy.verifyEndpoint('http://127.0.0.1:11434')).ok).toBe(true);
    expect(called).toBe(false);
  });
});

describe('isRemoteModel', () => {
  it('flags cloud tags and server-reported remote models', () => {
    expect(isRemoteModel({ name: 'gpt-oss:120b-cloud' })).toBe(true);
    expect(isRemoteModel({ name: 'qwen3-coder:480b-cloud' })).toBe(true);
    expect(isRemoteModel({ name: 'glm-4.6:cloud' })).toBe(true);
    expect(isRemoteModel({ name: 'qwen3.5:9b', remote: true })).toBe(true);
    expect(isRemoteModel({ name: 'qwen2.5-coder:3b-base' })).toBe(false);
    expect(isRemoteModel({ name: 'cloudy-coder:7b' })).toBe(false);
  });
});

describe('inspectOllamaExposure', () => {
  it('warns when the server listens on all interfaces', () => {
    const r = inspectOllamaExposure({ OLLAMA_HOST: '0.0.0.0:11434' });
    expect(r.bind).toBe('all-interfaces');
    expect(r.warnings.some((w) => w.includes('local network'))).toBe(true);
  });

  it('is quiet for a hardened default setup', () => {
    const r = inspectOllamaExposure({ OLLAMA_NO_CLOUD: '1' });
    expect(r.bind).toBe('loopback');
    expect(r.cloudDisabled).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('reads server.json and OLLAMA_ORIGINS', () => {
    const r = inspectOllamaExposure({ OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_ORIGINS: '*' }, { disable_ollama_cloud: true });
    expect(r.cloudDisabled).toBe(true);
    expect(r.originsWildcard).toBe(true);
    expect(r.warnings).toHaveLength(1);
  });
});
