import { describe, expect, it } from 'vitest';
// Plain .mjs module shared with the prebuild CLI.
import { scan } from '../../scripts/scrub-core.mjs';

interface Violation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

// The real denylist is injected from the environment at runtime; tests use a
// fake hostname so they stay hermetic and never name a real machine.
const HOSTS = ['examplehost'];

const rules = (text: string): string[] =>
  (scan(text, '<input>', { hostnames: HOSTS }) as Violation[]).map((v) => v.rule);

describe('scrub scan', () => {
  it('passes clean text', () => {
    expect(scan('Just a normal guide about cron patterns.\nNothing to see.', '<input>', { hostnames: HOSTS })).toEqual([]);
  });

  it('flags private hostnames', () => {
    expect(rules('ssh into examplehost and restart')).toContain('private-hostname');
  });

  it('omits the private-hostname rule when no denylist is configured', () => {
    // No hostnames -> the rule is dropped entirely, so even a configured-looking
    // host name is not flagged (the env-driven list is the only source of truth).
    expect((scan('ssh into examplehost and restart', '<input>', { hostnames: [] }) as Violation[]).map((v) => v.rule)).toEqual([]);
  });

  it('escapes regex metacharacters in hostnames', () => {
    // A dotted name must match literally, not as a regex wildcard.
    const r = (scan('connect to web.example and idle', '<input>', { hostnames: ['web.example'] }) as Violation[]).map((v) => v.rule);
    expect(r).toContain('private-hostname');
    const safe = (scan('connect to webXexample and idle', '<input>', { hostnames: ['web.example'] }) as Violation[]).map((v) => v.rule);
    expect(safe).toEqual([]);
  });

  it('flags RFC 1918 IPs but allows RFC 5737 doc IPs', () => {
    const privateIp = ['192', '168', '1', '20'].join('.');
    expect(rules(`the NAS lives at ${privateIp}`)).toContain('private-ipv4');
    expect(rules('use 192.0.2.10 as a placeholder')).toEqual([]);
    expect(rules('or 203.0.113.7 in examples')).toEqual([]);
  });

  it('flags API-key-shaped strings', () => {
    expect(rules('key: sk-abcdefghijklmnopqrstuvwxyz123456')).toContain('api-key');
    expect(rules('AKIAIOSFODNN7EXAMPLE7')).toContain('api-key');
    expect(rules('AIzaSyA-1234567890abcdefghijklmnopqrstu')).toContain('api-key');
  });

  it('flags emails but allows example domains and noreply', () => {
    const personalEmail = ['someone', 'gmail.com'].join('@');
    expect(rules(`contact me at ${personalEmail}`)).toContain('email');
    expect(rules('use admin@example.com in configs')).toEqual([]);
    const noreply = ['noreply', 'github.com'].join('@');
    expect(rules(`automated mail from ${noreply}`)).toEqual([]);
  });

  it('flags credentials but allows doc placeholders', () => {
    expect(rules('password=hunter7realsecret')).toContain('credential');
    expect(rules('password=REDACTED')).toEqual([]);
    expect(rules('password=yourpassword')).toEqual([]);
    expect(rules('password=<secret-from-vault>')).toEqual([]);
    expect(rules('password=$NAS_PASSWORD')).toEqual([]);
    expect(rules('-----BEGIN PRIVATE KEY-----')).toContain('credential');
  });

  it('honors inline allow tags on the same line', () => {
    expect(rules('the NAS lives at 192.168.1.20 <!-- content-guard: allow private-ipv4 -->')).toEqual([]);
  });

  it('honors inline allow tags on the previous line', () => {
    const text = '<!-- content-guard: allow private-hostname -->\nssh into examplehost';
    expect(rules(text)).toEqual([]);
  });

  it('does not let an allow tag suppress other rules', () => {
    const text = 'examplehost at 192.168.1.21 <!-- content-guard: allow private-ipv4 -->';
    expect(rules(text)).toEqual(['private-hostname']);
  });

  it('reports file and line', () => {
    const v = (scan('ok\nssh examplehost\nok', 'guide.md', { hostnames: HOSTS }) as Violation[])[0];
    expect(v).toMatchObject({ file: 'guide.md', line: 2, rule: 'private-hostname' });
  });
});
