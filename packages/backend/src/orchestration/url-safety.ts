/**
 * SSRF guard for user-influenced URL fetches in the research pipeline.
 *
 * The generation pipeline fetches URLs that ultimately come from untrusted
 * chat input (a user-typed documentation URL, or a URL surfaced by a web
 * search). The backend runs in-cluster, so an unguarded fetch of such a URL
 * is a Server-Side Request Forgery vector against cloud metadata endpoints
 * (169.254.169.254), loopback, RFC1918 ranges, and other cluster-internal
 * services.
 *
 * `assertPublicHttpUrl` is the single choke point every such fetch must pass
 * through, and `safeGet` wraps axios so every redirect hop is re-validated
 * (a public URL can 302 to an internal address).
 *
 * Deliberately NOT guarded: fetches to fixed, hardcoded trusted hosts
 * (api.github.com via Octokit, api.tavily.com) where the host is never
 * derived from user input - only the query string / path is. See
 * research.service.ts for where those calls live.
 */
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as dns from 'dns';
import * as net from 'net';
import { URL } from 'url';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Hostname suffixes/exact matches that are always internal, regardless of
// what they resolve to (or even if they don't resolve at all in this
// environment - e.g. Kubernetes' *.svc.cluster.local).
const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.cluster.local', '.localdomain'];
const BLOCKED_EXACT_HOSTS = new Set(['localhost']);

const DEFAULT_MAX_REDIRECTS = 2;
const DEFAULT_MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT_MS = 15000;

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

/** Parse a dotted-quad IPv4 string (already validated by net.isIP) into a 32-bit unsigned int. */
function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ipInt: number, base: string, prefix: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// RFC1918/CGNAT/link-local/loopback/reserved/documentation/multicast ranges.
const IPV4_BLOCKED_RANGES: Array<{ base: string; prefix: number }> = [
  { base: '0.0.0.0', prefix: 8 }, // "this network"
  { base: '10.0.0.0', prefix: 8 }, // RFC1918
  { base: '100.64.0.0', prefix: 10 }, // CGNAT
  { base: '127.0.0.0', prefix: 8 }, // loopback
  { base: '169.254.0.0', prefix: 16 }, // link-local (incl. cloud metadata IP)
  { base: '172.16.0.0', prefix: 12 }, // RFC1918
  { base: '192.0.0.0', prefix: 24 }, // IETF protocol assignments
  { base: '192.0.2.0', prefix: 24 }, // TEST-NET-1
  { base: '192.168.0.0', prefix: 16 }, // RFC1918
  { base: '198.18.0.0', prefix: 15 }, // benchmarking
  { base: '198.51.100.0', prefix: 24 }, // TEST-NET-2
  { base: '203.0.113.0', prefix: 24 }, // TEST-NET-3
  { base: '224.0.0.0', prefix: 4 }, // multicast
  { base: '240.0.0.0', prefix: 4 }, // reserved (incl. 255.255.255.255)
];

function isBlockedIpv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  return IPV4_BLOCKED_RANGES.some((r) => inCidr(ipInt, r.base, r.prefix));
}

/** Expand a validated IPv6 address string into a 16-byte buffer. */
function ipv6ToBuffer(ip: string): Buffer {
  let head = ip;
  let tail = '';
  const doubleColon = ip.indexOf('::');
  if (doubleColon !== -1) {
    head = ip.slice(0, doubleColon);
    tail = ip.slice(doubleColon + 2);
  }

  const parseGroups = (segment: string): number[] => {
    if (segment === '') return [];
    // Handle a trailing embedded IPv4 literal (e.g. "::ffff:127.0.0.1").
    const parts = segment.split(':');
    const groups: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes('.')) {
        // Embedded IPv4 - always the last "part", worth 2 groups.
        const ipInt = ipv4ToInt(part);
        groups.push((ipInt >>> 16) & 0xffff, ipInt & 0xffff);
      } else {
        groups.push(parseInt(part, 16));
      }
    }
    return groups;
  };

  const headGroups = parseGroups(head);
  const tailGroups = doubleColon !== -1 ? parseGroups(tail) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const allGroups = [...headGroups, ...new Array(Math.max(missing, 0)).fill(0), ...tailGroups];

  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(allGroups[i] || 0, i * 2);
  }
  return buf;
}

function isBlockedIpv6(ip: string): boolean {
  const buf = ipv6ToBuffer(ip);

  // ::1 loopback
  if (buf.equals(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))) return true;
  // :: unspecified
  if (buf.equals(Buffer.alloc(16))) return true;
  // fe80::/10 link-local
  if ((buf[0] & 0xff) === 0xfe && (buf[1] & 0xc0) === 0x80) return true;
  // fc00::/7 unique local (ULA)
  if ((buf[0] & 0xfe) === 0xfc) return true;
  // ff00::/8 multicast
  if (buf[0] === 0xff) return true;

  // ::ffff:0:0/96 IPv4-mapped - unwrap and re-check the embedded IPv4.
  const ipv4MappedPrefix = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);
  if (buf.subarray(0, 12).equals(ipv4MappedPrefix)) {
    const embedded = `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
    return isBlockedIpv4(embedded);
  }
  // ::/96 IPv4-compatible (deprecated but still worth unwrapping).
  if (buf.subarray(0, 12).equals(Buffer.alloc(12))) {
    const embedded = `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
    return isBlockedIpv4(embedded);
  }
  // 64:ff9b::/96 well-known NAT64 prefix - also unwraps to an IPv4 address.
  const nat64Prefix = Buffer.from([0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]);
  if (buf.subarray(0, 12).equals(nat64Prefix)) {
    const embedded = `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
    return isBlockedIpv4(embedded);
  }

  return false;
}

/**
 * Returns true if `ip` (a literal, already-validated IPv4 or IPv6 address
 * string) is in a private/reserved/loopback/link-local range and must not be
 * fetched.
 */
export function isBlockedIpLiteral(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  // Not a recognizable IP literal at all - treat as unsafe rather than let
  // it slip through.
  return true;
}

function hasBlockedHostSuffix(hostname: string): boolean {
  if (BLOCKED_EXACT_HOSTS.has(hostname)) return true;
  return BLOCKED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
}

/**
 * Validates that `rawUrl` is a fetchable public HTTP(S) URL: correct scheme,
 * not an internal hostname/TLD, and - after DNS resolution - not backed by
 * any private/reserved/loopback/link-local IP address. Every resolved
 * address is checked (not just the first) to defeat DNS answers that mix
 * public and internal addresses, and hostnames that resolve differently on
 * each lookup (DNS rebinding).
 *
 * Throws {@link UnsafeUrlError} on any violation. Never mutates the input.
 */
export async function assertPublicHttpUrl(
  rawUrl: string,
  deps: { lookup?: typeof dns.promises.lookup } = {},
): Promise<URL> {
  const lookup = deps.lookup ?? dns.promises.lookup;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(`Malformed URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new UnsafeUrlError(`Blocked scheme "${parsed.protocol}" for URL: ${rawUrl}`);
  }

  const hostname = stripBrackets(parsed.hostname).toLowerCase();
  if (!hostname) {
    throw new UnsafeUrlError(`URL has no hostname: ${rawUrl}`);
  }

  if (hasBlockedHostSuffix(hostname)) {
    throw new UnsafeUrlError(`Blocked internal hostname "${hostname}" for URL: ${rawUrl}`);
  }

  // If the hostname is itself an IP literal (the WHATWG URL parser already
  // normalizes decimal/octal/hex/shorthand IPv4 encodings, e.g.
  // "2130706433" or "017700000001", into canonical dotted-quad form), check
  // it directly without a DNS round-trip.
  if (net.isIP(hostname)) {
    if (isBlockedIpLiteral(hostname)) {
      throw new UnsafeUrlError(`Blocked IP literal "${hostname}" for URL: ${rawUrl}`);
    }
    return parsed;
  }

  // Otherwise resolve every address the hostname maps to and reject if any
  // single one is internal - a hostname can legitimately return multiple
  // A/AAAA records, and an attacker only needs one bad one to reach an
  // internal service.
  let addresses: dns.LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new UnsafeUrlError(
      `Could not resolve hostname "${hostname}" for URL: ${rawUrl} (${(error as Error).message})`,
    );
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Hostname "${hostname}" resolved to no addresses: ${rawUrl}`);
  }

  for (const { address } of addresses) {
    if (isBlockedIpLiteral(address)) {
      throw new UnsafeUrlError(
        `Hostname "${hostname}" resolves to blocked address ${address}: ${rawUrl}`,
      );
    }
  }

  return parsed;
}

/**
 * SSRF-safe `axios.get`: validates the URL (and every redirect hop) with
 * {@link assertPublicHttpUrl} before each request, and applies conservative
 * timeout/body-size defaults. Redirects are followed manually (rather than
 * via axios' `maxRedirects`) so that a public URL redirecting to an internal
 * address is caught instead of silently followed.
 */
export async function safeGet(
  url: string,
  config: AxiosRequestConfig = {},
  options: { maxRedirects?: number; lookup?: typeof dns.promises.lookup } = {},
): Promise<AxiosResponse> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertPublicHttpUrl(currentUrl, { lookup: options.lookup });

    const response = await axios.get(validated.toString(), {
      timeout: DEFAULT_TIMEOUT_MS,
      maxContentLength: DEFAULT_MAX_CONTENT_LENGTH,
      maxBodyLength: DEFAULT_MAX_CONTENT_LENGTH,
      ...config,
      maxRedirects: 0, // we re-validate and follow redirects ourselves
      validateStatus: (status) => status < 400,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location'];
      if (!location) {
        throw new UnsafeUrlError(`Redirect from ${currentUrl} had no Location header`);
      }
      currentUrl = new URL(location, validated).toString();
      continue;
    }

    return response;
  }

  throw new UnsafeUrlError(`Too many redirects (>${maxRedirects}) starting from ${url}`);
}
