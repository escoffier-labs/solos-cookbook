import { describe, expect, it } from 'vitest';
// Plain .mjs module shared with the prebuild CLI.
import { scan } from '../../scripts/scrub-core.mjs';

interface Violation {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

const rules = (text: string): string[] => (scan(text) as Violation[]).map((v) => v.rule);

describe('scrub scan', () => {
  it('passes clean text', () => {
    expect(scan('Just a normal guide about cron patterns.\nNothing to see.')).toEqual([]);
  });

  it('flags private hostnames', () => {
    expect(rules('ssh into gandalf and restart')).toContain('private-hostname');
  });

  it('flags RFC 1918 IPs but allows RFC 5737 doc IPs', () => {
    expect(rules('the NAS lives at 192.168.1.20')).toContain('private-ipv4');
    expect(rules('use 192.0.2.10 as a placeholder')).toEqual([]);
    expect(rules('or 203.0.113.7 in examples')).toEqual([]);
  });

  it('flags API-key-shaped strings', () => {
    expect(rules('key: sk-abcdefghijklmnopqrstuvwxyz123456')).toContain('api-key');
    expect(rules('AKIAIOSFODNN7EXAMPLE7')).toContain('api-key');
    expect(rules('AIzaSyA-1234567890abcdefghijklmnopqrstu')).toContain('api-key');
  });

  it('flags emails but allows example domains and noreply', () => {
    expect(rules('contact me at someone@gmail.com')).toContain('email');
    expect(rules('use admin@example.com in configs')).toEqual([]);
    expect(rules('automated mail from noreply@github.com')).toEqual([]);
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
    const text = '<!-- content-guard: allow private-hostname -->\nssh into gandalf';
    expect(rules(text)).toEqual([]);
  });

  it('does not let an allow tag suppress other rules', () => {
    const text = 'gandalf at 192.168.1.21 <!-- content-guard: allow private-ipv4 -->';
    expect(rules(text)).toEqual(['private-hostname']);
  });

  it('reports file and line', () => {
    const v = (scan('ok\nssh gandalf\nok', 'guide.md') as Violation[])[0];
    expect(v).toMatchObject({ file: 'guide.md', line: 2, rule: 'private-hostname' });
  });
});
