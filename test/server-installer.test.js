import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../deploy/linux/install.sh', import.meta.url));
const candidates = process.platform === 'win32'
  ? [process.env.BASH_PATH, 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe', 'bash']
  : [process.env.BASH_PATH, 'bash'];
const bash = candidates.filter(Boolean).find(candidate => {
  const result = spawnSync(candidate, ['--noprofile', '--norc', '-c', 'printf bash-ready'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 && result.stdout === 'bash-ready';
});
const shellPath = value => process.platform === 'win32'
  ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`)
  : value;
const skipBash = bash ? false : 'Bash is unavailable; set BASH_PATH (Git Bash on Windows)';

function run(script, args = [], env = {}) {
  return spawnSync(bash, ['--noprofile', '--norc', '-c', `source "$TEST_INSTALLER"\n${script}`, 'installer-test', ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, TEST_INSTALLER: shellPath(installer), ...env },
  });
}

function succeeded(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'arl-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, env: { TEST_ROOT: shellPath(root) } };
}

test('installer can be sourced without installing, prompting, or starting services', { skip: skipBash }, () => {
  const result = run('printf "source-only\\n"');
  succeeded(result);
  assert.equal(result.stdout, 'source-only\n');
  assert.equal(result.stderr, '');
});

test('installer parses explicitly supplied settings and supported release refs', { skip: skipBash }, () => {
  for (const ref of ['v0.10.0', 'main', 'releases/stable', 'a'.repeat(40)]) {
    const result = run('parse_args "$@"; printf "%s\\n" "$HOST" "$REF" "$USERNAME" "$LIMIT" "$CHECK_ONLY"',
      ['--host', 'lab.example.com', '--ref', ref, '--username', 'lab-admin', '--max-environments', '3', '--check']);
    succeeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), ['lab.example.com', ref, 'lab-admin', '3', '1']);
  }
});

test('installer rejects missing values, unknown flags and unsafe refs without evaluating them', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  const marker = shellPath(path.join(root, 'must-not-exist'));
  const cases = [
    ['--host'], ['--ref', '--check'], ['--username', ''], ['--max-environments'],
    ['--unknown'], ['--max-environments', '0'], ['--max-environments', '6'],
    ['--ref', '../main'], ['--ref', 'main/'], ['--ref', '-main'],
    ['--ref', `$(touch ${marker})`], ['--ref', `main;touch ${marker}`],
    ['--username', `admin;touch ${marker}`],
  ];
  for (const args of cases) {
    const result = run('parse_args "$@"', args, env);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `Accepted invalid arguments: ${JSON.stringify(args)}`);
    assert.match(result.stderr, /ERROR:/);
  }
  assert.equal(existsSync(path.join(root, 'must-not-exist')), false);
});

const pythonReady = bash && run('python3 -c "import ipaddress; print(123)"').stdout.trim() === '123';
const skipPython = skipBash || (pythonReady ? false : 'python3 is unavailable; host validation runs on Linux CI');

test('host validation accepts public IPv4 and DNS, and rejects unsupported IPv6, local addresses and injection', { skip: skipPython }, t => {
  const { root, env } = fixture(t);
  for (const [host, expected] of [
    ['1.1.1.1', ['ip', '1.1.1.1']],
    ['LAB.example.com', ['domain', 'lab.example.com']],
  ]) {
    const result = run('validate_host "$1"', [host], env);
    succeeded(result);
    assert.deepEqual(result.stdout.trim().split('\n'), expected);
  }
  for (const host of ['127.0.0.1', '10.0.0.1', '::1', '2606:4700:4700::1111', '[2606:4700:4700::1111]', 'localhost', 'a.local', 'a.test',
    'https://lab.example.com', 'lab.example.com:443', 'lab.example.com/path',
    'lab.example.com; return 200;', 'lab.example.com\ninclude /tmp/evil;', '999.999.999.999']) {
    const result = run('validate_host "$1"', [host], env);
    assert.notEqual(result.status, 0, `Accepted unsafe host: ${JSON.stringify(host)}`);
  }
  assert.equal(existsSync(path.join(root, 'evil')), false);
});

test('reading an existing environment file never executes shell content and rejects duplicate settings', { skip: skipPython }, t => {
  const { root, env } = fixture(t);
  const marker = shellPath(path.join(root, 'evaluated'));
  writeFileSync(path.join(root, 'settings'), `REGION_LAB_PUBLIC_ORIGIN=$(touch ${marker})\nOTHER=value\n`);
  const result = run('ENV_FILE="$TEST_ROOT/settings"; read_setting REGION_LAB_PUBLIC_ORIGIN', [], env);
  succeeded(result);
  assert.equal(result.stdout.trim(), `$(touch ${marker})`);
  assert.equal(existsSync(path.join(root, 'evaluated')), false);
  writeFileSync(path.join(root, 'settings'), 'PORT=4317\nPORT=4318\n');
  assert.notEqual(run('ENV_FILE="$TEST_ROOT/settings"; read_setting PORT', [], env).status, 0);
});

test('snapshots restore old contents and remove only newly introduced managed files', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  writeFileSync(path.join(root, 'existing'), 'original configuration\n');
  writeFileSync(path.join(root, 'unmanaged'), 'other application\n');
  const result = run(`
    BACKUP="$TEST_ROOT/backup"; mkdir "$BACKUP"
    snapshot "$TEST_ROOT/existing"
    snapshot "$TEST_ROOT/new-file"
    printf 'changed' > "$TEST_ROOT/existing"
    printf 'new' > "$TEST_ROOT/new-file"
    restore_configs
  `, [], env);
  succeeded(result);
  assert.equal(readFileSync(path.join(root, 'existing'), 'utf8'), 'original configuration\n');
  assert.equal(existsSync(path.join(root, 'new-file')), false);
  assert.equal(readFileSync(path.join(root, 'unmanaged'), 'utf8'), 'other application\n');
});

test('snapshot rollback preserves an original symlink without overwriting its target', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  writeFileSync(path.join(root, 'target'), 'original target\n');
  const result = run(`
    cd "$TEST_ROOT"
    ln -s target link
    [[ -L link ]] || exit 77
    BACKUP="$TEST_ROOT/backup"; mkdir "$BACKUP"
    snapshot "$TEST_ROOT/link"
    rm -- link
    printf 'replacement file' > link
    restore_configs
  `, [], env);
  if (result.status === 77) { t.skip('This filesystem/Git Bash does not create native symlinks'); return; }
  succeeded(result);
  assert.equal(lstatSync(path.join(root, 'link')).isSymbolicLink(), true);
  assert.equal(readlinkSync(path.join(root, 'link')), 'target');
  assert.equal(readFileSync(path.join(root, 'target'), 'utf8'), 'original target\n');
});

test('HTTP bootstrap preserves an existing matching HTTPS vhost byte for byte', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  const contents = 'server {\n listen 443 ssl;\n server_name lab.example.com;\n location /.well-known/acme-challenge/ { root /var/www/account-region-lab-acme; }\n ssl_certificate /existing/fullchain.pem;\n}\n';
  writeFileSync(path.join(root, 'vhost'), contents);
  const result = run('VHOST="$TEST_ROOT/vhost"; HOST=lab.example.com; ORIGIN=https://lab.example.com; write_http_config', [], env);
  succeeded(result);
  assert.equal(readFileSync(path.join(root, 'vhost'), 'utf8'), contents);
});

test('HTTP bootstrap refuses to overwrite a vhost for a different host', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  const contents = 'server { server_name another.example.com; root /var/www/account-region-lab-acme; }\n';
  writeFileSync(path.join(root, 'vhost'), contents);
  const result = run('VHOST="$TEST_ROOT/vhost"; HOST=lab.example.com; ORIGIN=https://lab.example.com; write_http_config', [], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing nginx host differs/i);
  assert.equal(readFileSync(path.join(root, 'vhost'), 'utf8'), contents);
});

test('a failed upgrade restores the old app/config and restarts only previously active services', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  mkdirSync(path.join(root, 'app-root', 'app'), { recursive: true });
  mkdirSync(path.join(root, 'backup', 'previous-app'), { recursive: true });
  writeFileSync(path.join(root, 'app-root', 'app', 'version'), 'broken-new');
  writeFileSync(path.join(root, 'backup', 'previous-app', 'version'), 'working-old');
  writeFileSync(path.join(root, 'vhost'), 'working HTTPS config');
  const result = run(`
    ROOT="$TEST_ROOT/app-root"; BACKUP="$TEST_ROOT/backup"
    WORK="$ROOT/.install.test"; mkdir "$WORK"
    snapshot "$TEST_ROOT/vhost"
    printf 'broken config' > "$TEST_ROOT/vhost"
    ACTIVATION_STARTED=1; SWITCHED=1; HAD_APP=1; WAS_ACTIVE=1
    systemctl() { printf '%s\\n' "$*" >> "$TEST_ROOT/services"; }
    nginx() { [[ "$1" == -t ]]; }
    trap cleanup EXIT
    exit 42
  `, [], env);
  assert.equal(result.status, 42, result.stderr);
  assert.equal(readFileSync(path.join(root, 'app-root', 'app', 'version'), 'utf8'), 'working-old');
  assert.equal(readFileSync(path.join(root, 'backup', 'failed-app', 'version'), 'utf8'), 'broken-new');
  assert.equal(readFileSync(path.join(root, 'vhost'), 'utf8'), 'working HTTPS config');
  assert.equal(existsSync(path.join(root, 'app-root', '.install.test')), false);
  assert.deepEqual(readFileSync(path.join(root, 'services'), 'utf8').trim().split('\n'), [
    'stop account-region-lab.service account-region-lab-gateway.service',
    'daemon-reload', 'start account-region-lab.service account-region-lab-gateway.service', 'reload nginx',
  ]);
});

test('a failure before the release switch leaves the old app and inactive services alone', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  mkdirSync(path.join(root, 'app-root', 'app'), { recursive: true });
  mkdirSync(path.join(root, 'backup'));
  writeFileSync(path.join(root, 'app-root', 'app', 'version'), 'working-old');
  writeFileSync(path.join(root, 'vhost'), 'working HTTPS config');
  const result = run(`
    ROOT="$TEST_ROOT/app-root"; BACKUP="$TEST_ROOT/backup"
    snapshot "$TEST_ROOT/vhost"
    printf 'broken config' > "$TEST_ROOT/vhost"
    systemctl() { printf '%s\\n' "$*" >> "$TEST_ROOT/services"; }
    nginx() { return 1; }
    trap cleanup EXIT
    exit 17
  `, [], env);
  assert.equal(result.status, 17);
  assert.equal(readFileSync(path.join(root, 'app-root', 'app', 'version'), 'utf8'), 'working-old');
  assert.equal(readFileSync(path.join(root, 'vhost'), 'utf8'), 'working HTTPS config');
  assert.equal(readFileSync(path.join(root, 'services'), 'utf8'), 'daemon-reload\n');
  assert.equal(existsSync(path.join(root, 'backup', 'failed-app')), false);
});

test('a failed activation before moving the old app restarts the previous running services', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  mkdirSync(path.join(root, 'app-root', 'app'), { recursive: true });
  mkdirSync(path.join(root, 'backup'));
  writeFileSync(path.join(root, 'app-root', 'app', 'version'), 'working-old');
  const result = run(`
    ROOT="$TEST_ROOT/app-root"; BACKUP="$TEST_ROOT/backup"
    : > "$BACKUP/managed-paths"
    ACTIVATION_STARTED=1; WAS_ACTIVE=1
    systemctl() { printf '%s\\n' "$*" >> "$TEST_ROOT/services"; }
    nginx() { return 1; }
    trap cleanup EXIT
    exit 19
  `, [], env);
  assert.equal(result.status, 19);
  assert.equal(readFileSync(path.join(root, 'app-root', 'app', 'version'), 'utf8'), 'working-old');
  assert.equal(existsSync(path.join(root, 'backup', 'failed-app')), false);
  assert.deepEqual(readFileSync(path.join(root, 'services'), 'utf8').trim().split('\n'), [
    'stop account-region-lab.service account-region-lab-gateway.service',
    'daemon-reload', 'start account-region-lab.service account-region-lab-gateway.service',
  ]);
});

test('check mode exits after validation without entering install or changing configuration', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  writeFileSync(path.join(root, 'config'), 'keep this');
  const result = run(`
    preflight() { printf 'validated\\n'; }
    flock() { printf 'Unexpected installation' >&2; exit 91; }
    apt-get() { printf 'Unexpected package install' >&2; exit 92; }
    systemctl() { printf 'Unexpected service change' >&2; exit 93; }
    main --host lab.example.com --check
  `, [], env);
  succeeded(result);
  assert.match(result.stdout, /validated\nRead-only checks passed/);
  assert.equal(readFileSync(path.join(root, 'config'), 'utf8'), 'keep this');
});

test('failed installation restores each saved unit state, including an enabled active certificate timer', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  mkdirSync(path.join(root, 'backup'));
  writeFileSync(path.join(root, 'vhost'), 'original HTTPS configuration');
  writeFileSync(path.join(root, 'backup', 'unit-states'), [
    'account-region-lab.service enabled active',
    'account-region-lab-gateway.service disabled active',
    'account-region-lab-certificate.timer enabled active',
    'account-region-lab-certificate.service disabled inactive',
  ].join('\n') + '\n');
  const result = run(`
    ROOT="$TEST_ROOT/app-root"; BACKUP="$TEST_ROOT/backup"
    snapshot "$TEST_ROOT/vhost"
    printf 'new broken config' > "$TEST_ROOT/vhost"
    systemctl() { printf '%s\\n' "$*" >> "$TEST_ROOT/services"; }
    nginx() { return 1; }
    trap cleanup EXIT
    exit 23
  `, [], env);
  assert.equal(result.status, 23, result.stderr);
  assert.equal(readFileSync(path.join(root, 'vhost'), 'utf8'), 'original HTTPS configuration');
  assert.deepEqual(readFileSync(path.join(root, 'services'), 'utf8').trim().split('\n'), [
    'stop account-region-lab.service', 'disable account-region-lab.service',
    'stop account-region-lab-gateway.service', 'disable account-region-lab-gateway.service',
    'stop account-region-lab-certificate.timer', 'disable account-region-lab-certificate.timer',
    'stop account-region-lab-certificate.service', 'disable account-region-lab-certificate.service',
    'daemon-reload',
    'enable account-region-lab.service', 'start account-region-lab.service',
    'start account-region-lab-gateway.service',
    'enable account-region-lab-certificate.timer', 'start account-region-lab-certificate.timer',
  ]);
});

test('failed first installation disables newly introduced timer without starting previously inactive units', { skip: skipBash }, t => {
  const { root, env } = fixture(t);
  mkdirSync(path.join(root, 'backup'));
  writeFileSync(path.join(root, 'backup', 'unit-states'), [
    'account-region-lab.service not-found inactive',
    'account-region-lab-gateway.service not-found inactive',
    'account-region-lab-certificate.timer not-found inactive',
  ].join('\n') + '\n');
  const result = run(`
    ROOT="$TEST_ROOT/app-root"; BACKUP="$TEST_ROOT/backup"
    snapshot "$TEST_ROOT/new-timer"
    printf 'new timer' > "$TEST_ROOT/new-timer"
    systemctl() { printf '%s\\n' "$*" >> "$TEST_ROOT/services"; }
    nginx() { return 1; }
    trap cleanup EXIT
    exit 24
  `, [], env);
  assert.equal(result.status, 24, result.stderr);
  assert.equal(existsSync(path.join(root, 'new-timer')), false);
  const calls = readFileSync(path.join(root, 'services'), 'utf8').trim().split('\n');
  assert.ok(calls.includes('stop account-region-lab-certificate.timer'));
  assert.ok(calls.includes('disable account-region-lab-certificate.timer'));
  assert.ok(calls.includes('daemon-reload'));
  assert.equal(calls.some(call => /^(start|enable) /.test(call)), false);
});
