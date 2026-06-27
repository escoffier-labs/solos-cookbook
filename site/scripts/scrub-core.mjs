/**
 * Publish-boundary content scanner core.
 *
 * Self-contained mirror of the spirit of the repo's content-guard pre-push
 * hook, so the Vercel build can fail on a leak without cloning a second
 * repo. Honors the same inline escape hatch:
 *
 *   <!-- content-guard: allow <rule-id> -->
 *
 * The private-hostname denylist is intentionally NOT hardcoded here. It is
 * loaded from the SCRUB_HOSTNAMES environment variable (set locally and in
 * the Vercel project), so this public source never names the real machines.
 * See site/.env.example.
 */

/** RFC 5737 documentation ranges are fine in public docs. */
const DOC_IP = /^(192\.0\.2|198\.51\.100|203\.0\.113)\./;

/** Escape a string for safe use inside a RegExp. */
export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a hostname denylist from a raw string (comma- and/or
 * whitespace-separated). Trims entries and drops empties.
 * @param {string} [raw] defaults to process.env.SCRUB_HOSTNAMES
 * @returns {string[]}
 */
export function parseHostnames(raw = process.env.SCRUB_HOSTNAMES) {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);
}

/** Build the private-hostname rule for a given denylist, or null if empty. */
function hostnameRule(hostnames) {
  if (!hostnames || hostnames.length === 0) return null;
  const alternation = hostnames.map(escapeRegExp).join('|');
  return {
    id: 'private-hostname',
    pattern: new RegExp('\\b(' + alternation + ')\\b', 'gi'),
    describe: 'private machine hostname',
  };
}

/** Rules that never depend on the runtime hostname denylist. */
const STATIC_RULES = [
  {
    id: 'private-ipv4',
    pattern: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    describe: 'RFC 1918 private IP',
    filter: (match) => !DOC_IP.test(match),
  },
  {
    id: 'api-key',
    pattern: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,})/g,
    describe: 'API-key-shaped string',
  },
  {
    id: 'email',
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    describe: 'email address',
    filter: (match) => {
      const allow = ['example.com', 'example.org', 'noreply@', 'users.noreply.'];
      return !allow.some((a) => match.toLowerCase().includes(a));
    },
  },
  {
    id: 'credential',
    pattern: /(BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|password\s*=\s*\S+|Authorization:\s*Bearer\s+[A-Za-z0-9._-]{10,})/g,
    describe: 'credential material',
    filter: (match) => {
      // Skip obvious doc placeholders: password=REDACTED, password=yourpassword,
      // password=<secret>, password=$VAR, password=`...` and the like.
      const value = match.replace(/^password\s*=\s*/i, '');
      if (value === match) return true; // not a password= match; keep
      return !/^(`|<|\$|\*|x{4,}|REDACTED|your|you\b|example|changeme|placeholder|dummy|fake|hunter2)/i.test(value);
    },
  },
];

/**
 * Build the active rule set for a given hostname denylist. When the denylist
 * is empty, the private-hostname rule is OMITTED entirely (no catch-all
 * regex is emitted).
 * @param {string[]} hostnames
 * @returns {object[]}
 */
export function buildRules(hostnames) {
  const hostRule = hostnameRule(hostnames);
  return hostRule ? [hostRule, ...STATIC_RULES] : [...STATIC_RULES];
}

/**
 * Rules built from the ambient environment (SCRUB_HOSTNAMES). Exposed for
 * callers that want the default rule set without re-parsing the env.
 */
export const RULES = buildRules(parseHostnames());

const ALLOW_TAG = /content-guard:\s*allow\s+([\w-]+)/g;

function allowedRules(line) {
  const ids = new Set();
  for (const m of line.matchAll(ALLOW_TAG)) ids.add(m[1]);
  return ids;
}

/**
 * Scan text for violations.
 * @param {string} text file contents
 * @param {string} file display path
 * @param {{hostnames?: string[]}} [opts] hostnames overrides the env-derived
 *   denylist (used by tests and callers that resolve the list themselves).
 * @returns {{file: string, line: number, rule: string, snippet: string}[]}
 */
export function scan(text, file = '<input>', opts = {}) {
  const hostnames = opts.hostnames ?? parseHostnames();
  const rules = buildRules(hostnames);
  const violations = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Allow tags on the offending line or the line directly above it.
    const allowed = allowedRules(line);
    if (i > 0) for (const id of allowedRules(lines[i - 1])) allowed.add(id);
    for (const rule of rules) {
      if (allowed.has(rule.id)) continue;
      for (const match of line.matchAll(rule.pattern)) {
        const hit = match[0];
        if (rule.filter && !rule.filter(hit)) continue;
        violations.push({
          file,
          line: i + 1,
          rule: rule.id,
          snippet: line.trim().slice(0, 120),
        });
        break; // one report per rule per line is enough
      }
    }
  }
  return violations;
}
