// Local-only policy: every byte the extension sends must go to a loopback address.
// This module is the single authority on that question; the HTTP client calls it
// before every request and the extension refuses to start a provider otherwise.

export type PolicyResult = { ok: true } | { ok: false; reason: string };

export class LocalOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalOnlyViolation';
  }
}

function isIpv4Loopback(host: string): boolean {
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** True for 127.0.0.0/8, ::1 (any spelling), IPv4-mapped loopback, and the name "localhost". */
export function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost') return true;
  if (isIpv4Loopback(host)) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || /^0{1,4}(:0{1,4}){6}:0{0,3}1$/.test(host)) return true;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return isIpv4Loopback(mapped[1]);
  // WHATWG URL normalises ::ffff:127.0.0.1 to ::ffff:7f00:1
  const mappedHex = /^::ffff:7f([0-9a-f]{2}):([0-9a-f]{1,4})$/.exec(host);
  return !!mappedHex;
}

export function checkEndpointUrl(raw: string): PolicyResult & { url?: URL } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid URL.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol "${url.protocol}" (only http/https to loopback).` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Credentials in the endpoint URL are not allowed.' };
  }
  if (!isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      reason: `Refused: "${url.hostname}" is not a loopback address. Local Copilot only talks to 127.0.0.1, ::1 or localhost.`,
    };
  }
  return { ok: true, url };
}

export type Resolver = (hostname: string) => Promise<string[]>;

export class LocalOnlyPolicy {
  constructor(private readonly resolve?: Resolver) {}

  /** Synchronous guard used before every request. Throws LocalOnlyViolation. */
  assertAllowed(url: string): void {
    const result = checkEndpointUrl(url);
    if (!result.ok) throw new LocalOnlyViolation(result.reason);
  }

  /**
   * Full verification of an endpoint: syntax + loopback + (for names) DNS
   * resolution must only yield loopback addresses, so a tampered hosts file
   * mapping "localhost" elsewhere is caught.
   */
  async verifyEndpoint(raw: string): Promise<PolicyResult & { addresses?: string[] }> {
    const result = checkEndpointUrl(raw);
    if (!result.ok || !result.url) return result;
    const host = result.url.hostname.replace(/^\[/, '').replace(/\]$/, '');
    const isLiteral = isIpv4Loopback(host) || host.includes(':');
    if (isLiteral || !this.resolve) return { ok: true, addresses: [host] };
    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch (err) {
      return { ok: false, reason: `Could not resolve "${host}": ${(err as Error).message}` };
    }
    const bad = addresses.filter((a) => !isLoopbackHost(a));
    if (addresses.length === 0 || bad.length > 0) {
      return { ok: false, reason: `"${host}" resolves to non-loopback address(es): ${bad.join(', ') || 'none'}.` };
    }
    return { ok: true, addresses };
  }
}

/** Models served by a remote backend (e.g. Ollama ":cloud" / "-cloud" tags) are never used. */
export function isRemoteModel(model: { name: string; remote?: boolean }): boolean {
  if (model.remote) return true;
  const tag = model.name.toLowerCase();
  return /(^|[:\-])cloud$/.test(tag) || /:cloud\b/.test(tag);
}

export type ExposureLevel = 'loopback' | 'all-interfaces' | 'network' | 'unknown';

export interface ServerExposureReport {
  bind: ExposureLevel;
  bindValue: string;
  cloudDisabled: boolean | undefined;
  originsWildcard: boolean;
  warnings: string[];
}

/**
 * Inspects the Ollama server environment (as seen by this process) for settings
 * that weaken local-only operation. Pure: the caller passes env + server.json.
 */
export function inspectOllamaExposure(env: Record<string, string | undefined>, serverJson?: { disable_ollama_cloud?: boolean }): ServerExposureReport {
  const warnings: string[] = [];
  const raw = (env.OLLAMA_HOST ?? '').trim();
  let bind: ExposureLevel = 'loopback';
  if (raw) {
    const hostPart = raw.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (hostPart === '' || hostPart === '0.0.0.0' || hostPart === '::' || hostPart === '*') bind = 'all-interfaces';
    else if (isLoopbackHost(hostPart)) bind = 'loopback';
    else if (/^[\d.]+$/.test(hostPart) || hostPart.includes(':')) bind = 'network';
    else bind = 'unknown';
  }
  if (bind === 'all-interfaces' || bind === 'network') {
    warnings.push(
      `OLLAMA_HOST=${raw} makes the Ollama server reachable from your local network: anyone on it can send prompts or read your model list. Set OLLAMA_HOST=127.0.0.1:11434 unless you need LAN access.`,
    );
  }
  const envNoCloud = (env.OLLAMA_NO_CLOUD ?? '').trim().toLowerCase();
  let cloudDisabled: boolean | undefined;
  if (envNoCloud === '1' || envNoCloud === 'true') cloudDisabled = true;
  else if (serverJson?.disable_ollama_cloud === true) cloudDisabled = true;
  else if (envNoCloud === '0' || envNoCloud === 'false' || serverJson?.disable_ollama_cloud === false) cloudDisabled = false;
  if (cloudDisabled !== true) {
    warnings.push(
      'Ollama cloud features are not disabled. Local Copilot never selects cloud models, but you can lock the server itself with OLLAMA_NO_CLOUD=1 (or "disable_ollama_cloud": true in ~/.ollama/server.json).',
    );
  }
  const origins = env.OLLAMA_ORIGINS ?? '';
  const originsWildcard = origins.split(',').some((o) => o.trim() === '*');
  if (originsWildcard) {
    warnings.push('OLLAMA_ORIGINS=* lets any website open in your browser call your local Ollama server.');
  }
  return { bind, bindValue: raw || '127.0.0.1:11434 (default)', cloudDisabled, originsWildcard, warnings };
}
