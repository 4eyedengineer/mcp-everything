/// <reference types="jest" />
import * as dns from 'dns';
import { assertPublicHttpUrl, isBlockedIpLiteral, safeGet, UnsafeUrlError } from './url-safety';

// Mock axios so safeGet's HTTP calls never actually hit the network - only
// the SSRF-guard logic (which runs before any axios call) is under test
// here, plus the redirect re-validation loop.
jest.mock('axios', () => ({
  get: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios');

// Deterministic, offline DNS: public hostnames resolve to a public IP,
// internal-sounding hostnames resolve to a private/loopback/link-local IP.
// This lets the test assert real DNS-resolution behavior (not just literal
// IP parsing) without touching the network.
const DNS_MAP: Record<string, Array<{ address: string; family: number }>> = {
  'api.stripe.com': [{ address: '104.16.132.229', family: 4 }], // stand-in public IP for this fixture
  'docs.github.com': [{ address: '151.101.1.140', family: 4 }],
  'evil.example.com': [{ address: '10.0.0.5', family: 4 }],
  'foo.svc.cluster.local': [{ address: '10.0.0.6', family: 4 }],
  'rebinding.example.com': [{ address: '169.254.169.254', family: 4 }],
};

function mockLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const entry = DNS_MAP[hostname];
  if (entry) return Promise.resolve(entry);
  const err: any = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  err.code = 'ENOTFOUND';
  return Promise.reject(err);
}

describe('url-safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isBlockedIpLiteral', () => {
    it('blocks loopback (IPv4 and IPv6)', () => {
      expect(isBlockedIpLiteral('127.0.0.1')).toBe(true);
      expect(isBlockedIpLiteral('127.0.0.2')).toBe(true);
      expect(isBlockedIpLiteral('::1')).toBe(true);
    });

    it('blocks the cloud metadata / link-local range', () => {
      expect(isBlockedIpLiteral('169.254.169.254')).toBe(true);
      expect(isBlockedIpLiteral('169.254.0.1')).toBe(true);
    });

    it('blocks RFC1918 private ranges', () => {
      expect(isBlockedIpLiteral('10.0.0.5')).toBe(true);
      expect(isBlockedIpLiteral('172.16.0.1')).toBe(true);
      expect(isBlockedIpLiteral('172.31.255.255')).toBe(true);
      expect(isBlockedIpLiteral('192.168.1.1')).toBe(true);
    });

    it('blocks CGNAT (100.64.0.0/10)', () => {
      expect(isBlockedIpLiteral('100.64.0.1')).toBe(true);
      expect(isBlockedIpLiteral('100.127.255.255')).toBe(true);
    });

    it('blocks IPv6 unique-local and unspecified addresses', () => {
      expect(isBlockedIpLiteral('fc00::1')).toBe(true);
      expect(isBlockedIpLiteral('fd12:3456:789a::1')).toBe(true);
      expect(isBlockedIpLiteral('::')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 addresses that embed a private IPv4', () => {
      expect(isBlockedIpLiteral('::ffff:127.0.0.1')).toBe(true);
      expect(isBlockedIpLiteral('::ffff:169.254.169.254')).toBe(true);
      // Canonical hex form of ::ffff:127.0.0.1, as produced by the WHATWG
      // URL parser for a bracketed IPv6 literal.
      expect(isBlockedIpLiteral('::ffff:7f00:1')).toBe(true);
    });

    it('allows public IPv4 and IPv6 addresses', () => {
      expect(isBlockedIpLiteral('8.8.8.8')).toBe(false);
      expect(isBlockedIpLiteral('1.1.1.1')).toBe(false);
      expect(isBlockedIpLiteral('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
    });
  });

  describe('assertPublicHttpUrl', () => {
    it('allows a normal public https URL (mocked DNS -> public IP)', async () => {
      await expect(
        assertPublicHttpUrl('https://api.stripe.com/v1/charges', { lookup: mockLookup as any }),
      ).resolves.toBeInstanceOf(URL);
    });

    it('allows a normal public http URL', async () => {
      await expect(
        assertPublicHttpUrl('https://docs.github.com/en/rest', { lookup: mockLookup as any }),
      ).resolves.toBeInstanceOf(URL);
    });

    it('blocks the cloud metadata IP literal', async () => {
      await expect(
        assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/', {
          lookup: mockLookup as any,
        }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks 127.0.0.1', async () => {
      await expect(
        assertPublicHttpUrl('http://127.0.0.1/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks bare localhost', async () => {
      await expect(
        assertPublicHttpUrl('http://localhost/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks an RFC1918 IP literal (10.x)', async () => {
      await expect(
        assertPublicHttpUrl('http://10.0.0.5/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks an RFC1918 IP literal (192.168.x)', async () => {
      await expect(
        assertPublicHttpUrl('http://192.168.1.1/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks a hostname with the .svc.cluster.local suffix, even before DNS resolution', async () => {
      const lookup = jest.fn(mockLookup as any);
      await expect(
        assertPublicHttpUrl('http://foo.svc.cluster.local/', { lookup: lookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
      // Blocked on the hostname suffix alone - no need to even resolve it.
      expect(lookup).not.toHaveBeenCalled();
    });

    it('blocks an IPv6 loopback literal', async () => {
      await expect(
        assertPublicHttpUrl('http://[::1]/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks a decimal-encoded IP literal (2130706433 === 127.0.0.1)', async () => {
      await expect(
        assertPublicHttpUrl('http://2130706433/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks an octal-encoded IP literal (017700000001 === 127.0.0.1)', async () => {
      await expect(
        assertPublicHttpUrl('http://017700000001/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks a hex-encoded IP literal (0x7f000001 === 127.0.0.1)', async () => {
      await expect(
        assertPublicHttpUrl('http://0x7f000001/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks a public-looking hostname that resolves to a private IP', async () => {
      await expect(
        assertPublicHttpUrl('http://evil.example.com/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks a public-looking hostname that resolves to the metadata IP (rebinding)', async () => {
      await expect(
        assertPublicHttpUrl('http://rebinding.example.com/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks file:// and other non-http(s) schemes', async () => {
      await expect(
        assertPublicHttpUrl('file:///etc/passwd', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
      await expect(
        assertPublicHttpUrl('gopher://127.0.0.1/', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
      await expect(
        assertPublicHttpUrl('ftp://example.com/file', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
      await expect(
        assertPublicHttpUrl('data:text/plain;base64,aGk=', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks a malformed URL rather than throwing an unhandled error', async () => {
      await expect(
        assertPublicHttpUrl('not a url at all', { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('blocks a hostname that fails to resolve', async () => {
      await expect(
        assertPublicHttpUrl('https://this-does-not-exist.example.invalid/', {
          lookup: mockLookup as any,
        }),
      ).rejects.toThrow(UnsafeUrlError);
    });
  });

  describe('safeGet', () => {
    it('fetches a validated public URL', async () => {
      axios.get.mockResolvedValueOnce({ status: 200, data: 'ok', headers: {} });

      const response = await safeGet(
        'https://api.stripe.com/v1/charges',
        {},
        { lookup: mockLookup as any },
      );

      expect(response.data).toBe('ok');
      expect(axios.get).toHaveBeenCalledTimes(1);
      const [calledUrl, calledConfig] = axios.get.mock.calls[0];
      expect(calledUrl).toBe('https://api.stripe.com/v1/charges');
      expect(calledConfig.maxRedirects).toBe(0);
    });

    it('refuses to fetch a blocked URL without ever calling axios', async () => {
      await expect(
        safeGet('http://169.254.169.254/latest/meta-data/', {}, { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('follows a redirect to another public host after re-validating it', async () => {
      axios.get
        .mockResolvedValueOnce({
          status: 302,
          data: '',
          headers: { location: 'https://docs.github.com/en/rest' },
        })
        .mockResolvedValueOnce({ status: 200, data: 'redirected-ok', headers: {} });

      const response = await safeGet(
        'https://api.stripe.com/v1/charges',
        {},
        { lookup: mockLookup as any },
      );

      expect(response.data).toBe('redirected-ok');
      expect(axios.get).toHaveBeenCalledTimes(2);
      expect(axios.get.mock.calls[1][0]).toBe('https://docs.github.com/en/rest');
    });

    it('blocks a redirect from a public URL to an internal address', async () => {
      axios.get.mockResolvedValueOnce({
        status: 302,
        data: '',
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });

      await expect(
        safeGet('https://api.stripe.com/v1/charges', {}, { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);

      // Only the first hop was ever fetched - the malicious redirect target
      // was never requested.
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    it('blocks a redirect to a hostname that resolves to a private IP', async () => {
      axios.get.mockResolvedValueOnce({
        status: 302,
        data: '',
        headers: { location: 'http://evil.example.com/' },
      });

      await expect(
        safeGet('https://api.stripe.com/v1/charges', {}, { lookup: mockLookup as any }),
      ).rejects.toThrow(UnsafeUrlError);
    });

    it('gives up after too many redirect hops', async () => {
      axios.get.mockResolvedValue({
        status: 302,
        data: '',
        headers: { location: 'https://docs.github.com/en/rest' },
      });

      await expect(
        safeGet(
          'https://api.stripe.com/v1/charges',
          {},
          { lookup: mockLookup as any, maxRedirects: 1 },
        ),
      ).rejects.toThrow(UnsafeUrlError);
    });
  });

  describe('lookup default wiring', () => {
    it('uses dns.promises.lookup when no override is supplied', async () => {
      const spy = jest
        .spyOn(dns.promises, 'lookup')
        .mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as any);

      await assertPublicHttpUrl('https://example.com/');

      expect(spy).toHaveBeenCalledWith('example.com', { all: true, verbatim: true });
      spy.mockRestore();
    });
  });
});
