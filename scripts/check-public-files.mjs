import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const PRIVATE_NAMES = new Set([
  'access.json', 'server-access.json', 'server-login.txt', 'state.json',
  'account-region-lab-credentials.txt',
  'proxy-vault.key', 'proxy-auth.key', 'launcher.local.json', '.server.lock',
  'cookies', 'cookies-journal', 'login data', 'login data-journal',
  'local state', 'web data', 'web data-journal', '.xauthority',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
]);

export function inspectPublicFile(file, contents) {
  const normalized = file.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  const name = basename(lower);
  const issues = new Set();
  const report = type => issues.add(type);
  if (PRIVATE_NAMES.has(name)
    || /(?:^|\/)(?:data|profiles|backups|\.ssh|work)(?:\/|$)/.test(lower)
    || /^\.env(?:\.|$)/.test(name) && !name.endsWith('.example')
    || /\.(?:pem|key|p12|pfx)$/.test(name)
    || /^(?:browser-diagnostics-|account-region-observations).*\.json$/.test(name)) {
    report('sensitive runtime or credential file');
  }
  if (/\.(?:zip|tar|tar\.gz|tgz|7z|bak|backup|log)$/.test(name)) {
    report('private archive, backup or log');
  }
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (buffer.length > MAX_TEXT_BYTES) {
    report('file exceeds public-content scan limit');
    return [...issues].map(type => ({ file, type }));
  }
  let text = buffer.toString('utf8');
  // Also inspect UTF-16 source/config files instead of silently treating them as binary.
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff && buffer.length % 2 === 0) text = Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) {
    report('private key material');
  }
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(text)) {
    report('possible API credential');
  }
  // Parser fixtures contain deliberately malformed URLs; tests still receive all checks above.
  if (!lower.startsWith('test/')) {
    const urls = [...text.matchAll(/\b(?:socks[45]h?|https?):\/\/([^\s/"'<>`:@]+):([^\s/"'<>`@]+)@[^\s/"'<>`]+/gi)];
    const hasLiteralUrl = urls.some(([, user, password]) => !(
      user === '用户名' && password === '密码'
      || user === 'USERNAME' && password === 'PASSWORD'
    ));
    if (hasLiteralUrl
      || /\b(?:[a-z0-9-]+\.)+[a-z]{2,}:\d{2,5}:[^\s:"'<>`]{1,}:[^\s"'<>`]{1,}/i.test(text)) {
      report('literal proxy or URL credentials');
    }
  }
  return [...issues].map(type => ({ file, type }));
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

export function checkTrackedPublicFiles(cwd) {
  const entries = git(cwd, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).map(entry => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Cannot read tracked file metadata');
    return { mode: match[1], object: match[2], stage: match[3], file: match[4] };
  });
  const findings = [];
  const blobs = [...new Set(entries.filter(entry => entry.mode !== '160000').map(entry => entry.object))];
  const sizes = blobs.length ? git(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: blobs.join('\n') + '\n' }).toString('utf8').trim().split('\n') : [];
  const allowed = new Set();
  for (const line of sizes) {
    const [object, type, size] = line.split(' ');
    if (type === 'blob' && Number(size) <= MAX_TEXT_BYTES) allowed.add(object);
  }
  const requested = [...allowed];
  const raw = requested.length ? git(cwd, ['cat-file', '--batch'], { input: requested.join('\n') + '\n' }) : Buffer.alloc(0);
  const contents = new Map();
  let offset = 0;
  for (const object of requested) {
    const end = raw.indexOf(10, offset);
    const [returned, type, size] = raw.subarray(offset, end).toString('utf8').split(' ');
    if (end === -1 || returned !== object || type !== 'blob' || !/^\d+$/.test(size)) throw new Error('Cannot read tracked file content');
    offset = end + 1;
    contents.set(object, raw.subarray(offset, offset + Number(size)));
    offset += Number(size) + 1;
  }
  for (const entry of entries) {
    if (entry.mode === '160000') {
      findings.push({ file: entry.file, type: 'submodule requires a separate public-content audit' });
      continue;
    }
    if (!allowed.has(entry.object)) findings.push({ file: entry.file, type: 'file exceeds public-content scan limit' });
    else findings.push(...inspectPublicFile(entry.file, contents.get(entry.object)));
    if (entry.mode === '120000') {
      findings.push({ file: entry.file, type: 'symbolic link requires a separate public-content audit' });
      continue;
    }
    try {
      findings.push(...inspectPublicFile(entry.file, readFileSync(resolve(cwd, entry.file))));
    } catch (error) {
      // Staged deletions have no index entry. An unstaged deletion is still scanned from the index.
      if (error.code !== 'ENOENT') findings.push({ file: entry.file, type: 'tracked working file cannot be inspected' });
    }
  }
  return { files: new Set(entries.map(entry => entry.file)).size, findings: [...new Map(findings.map(item => [`${item.file}\0${item.type}`, item])).values()] };
}

export function formatPublicFindings(findings) {
  return findings.map(({ file, type }) => `${JSON.stringify(file)}: ${type}`).join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkTrackedPublicFiles(process.cwd());
    if (result.findings.length) {
      console.error(`Public-file check failed (${result.findings.length} findings):\n${formatPublicFindings(result.findings)}`);
      process.exitCode = 1;
    } else console.log(`Public-file check passed (${result.files} tracked files; staged and working contents).`);
  } catch {
    console.error('Public-file check could not inspect this Git checkout. Run it from the repository root with Git installed.');
    process.exitCode = 1;
  }
}
