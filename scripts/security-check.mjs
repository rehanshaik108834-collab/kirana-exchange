import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const FORBIDDEN_TRACKED_FILES = [
  /(^|\/)\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|jks)$/i,
  /(^|\/)id_rsa(\.pub)?$/i,
];

const ALLOWED_ENV_EXAMPLES = /(^|\/)\.env\.(example|sample|template)$/i;

const SECRET_PATTERNS = [
  { name: 'Private Key Block', regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS Access Key ID', regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub Token', regex: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { name: 'Google API Key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack Token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Stripe Live Secret', regex: /\bsk_live_[0-9A-Za-z]{20,}\b/ },
];

function getTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function main() {
  const files = getTrackedFiles();
  const findings = [];

  for (const relPath of files) {
    if (
      FORBIDDEN_TRACKED_FILES.some((re) => re.test(relPath)) &&
      !ALLOWED_ENV_EXAMPLES.test(relPath)
    ) {
      findings.push({ file: relPath, issue: 'Forbidden secret/env file tracked in git' });
      continue;
    }

    if (relPath === 'scripts/security-check.mjs') continue;

    const absPath = resolve(relPath);
    let size = 0;
    try {
      size = statSync(absPath).size;
    } catch {
      continue;
    }
    if (size === 0 || size > 1_000_000) continue;

    let content = '';
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\0')) continue; // skip binaries

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const rule of SECRET_PATTERNS) {
        if (rule.regex.test(lines[i])) {
          findings.push({
            file: relPath,
            line: i + 1,
            issue: `Matched secret pattern: ${rule.name}`,
          });
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error('SECURITY CHECK FAILED — potential secrets detected:');
    for (const f of findings) {
      console.error(`  - ${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue}`);
    }
    process.exit(1);
  }

  console.log(`SECURITY CHECK PASSED: scanned ${files.length} tracked files with 0 secret findings.`);
}

main();
