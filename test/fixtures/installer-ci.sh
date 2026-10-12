#!/usr/bin/env bash
# Destructive integration fixture for an otherwise clean, disposable GitHub VM.
# Real apt, Node, Chrome, systemd and nginx are exercised. Only ACME issuance is
# replaced with a private CA generated on the runner; this is NOT a Let's Encrypt
# issuance test, ARM test, or test of users' residential proxy connections.
set -Eeuo pipefail
umask 077

[[ ${GITHUB_ACTIONS:-} == true && ${ARL_RUNNER_ENVIRONMENT:-} == github-hosted && $EUID == 0 ]] || {
  printf '%s\n' 'This fixture runs only as root on a disposable GitHub-hosted runner.' >&2
  exit 1
}
[[ $# == 1 && $1 =~ ^[a-f0-9]{40}$ ]] || { printf '%s\n' 'Expected the published GitHub commit SHA.' >&2; exit 1; }
REF=$1
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
ROOT=/opt/account-region-lab
DATA_HOME=/var/lib/account-region-lab
RECEIPT=/root/account-region-lab-credentials.txt
TRUST=/usr/local/share/ca-certificates/account-region-lab-ci.crt
WORK=''
PHASE=preflight

for path in "$ROOT" "$DATA_HOME" "$RECEIPT" "$TRUST" /etc/account-region-lab.env /etc/nginx/sites-available/account-region-lab; do
  [[ ! -e $path && ! -L $path ]] || { printf 'Refusing an existing installation path: %s\n' "$path" >&2; exit 1; }
done
! id regionlab >/dev/null 2>&1 || { printf '%s\n' 'Refusing an existing service account.' >&2; exit 1; }
[[ $(dpkg --print-architecture) == amd64 && -d /run/systemd/system ]] || exit 1
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || exit 1
WORK=$(mktemp -d /root/account-region-lab-ci.XXXXXXXX)

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  # Never print installer logs or service journals: these can contain credentials
  # if a future regression causes accidental logging. The phase identifies the
  # failed assertion without publishing the generated account or its browser data.
  if ((status)); then printf 'Installer integration failed during: %s (exit %s).\n' "$PHASE" "$status" >&2; fi
  systemctl disable --now account-region-lab-certificate.timer account-region-lab-gateway.service account-region-lab.service >/dev/null 2>&1
  systemctl stop account-region-lab-certificate.service nginx >/dev/null 2>&1
  if id regionlab >/dev/null 2>&1; then pkill -TERM -u regionlab >/dev/null 2>&1; fi
  rm -f -- /etc/nginx/sites-enabled/account-region-lab /etc/nginx/sites-available/account-region-lab /etc/account-region-lab.env "$RECEIPT" "$TRUST"
  rm -f -- /etc/systemd/system/account-region-lab.service /etc/systemd/system/account-region-lab-gateway.service /etc/systemd/system/account-region-lab-certificate.service /etc/systemd/system/account-region-lab-certificate.timer
  systemctl daemon-reload >/dev/null 2>&1
  if [[ -f $WORK/hosts.original ]]; then cp -- "$WORK/hosts.original" /etc/hosts; fi
  update-ca-certificates >/dev/null 2>&1
  # All targets were checked absent above; these exact fixture paths belong only
  # to this disposable run, not to a user's server or the checked-out repository.
  rm -rf -- /opt/account-region-lab /var/lib/account-region-lab /var/www/account-region-lab-acme
  [[ $WORK == /root/account-region-lab-ci.* ]] && rm -rf -- "$WORK"
  exit "$status"
}
trap cleanup EXIT

progress() { PHASE=$1; printf 'Installer integration: %s\n' "$PHASE"; }
assert_healthy() {
  local ready=0 attempt
  for unit in account-region-lab.service account-region-lab-gateway.service account-region-lab-certificate.timer; do
    systemctl is-active --quiet "$unit"
    [[ $(systemctl is-enabled "$unit") == enabled ]]
  done
  # Type=exec confirms execve(), not HTTP readiness. Rollback starts the old
  # processes afresh, so give their listeners a bounded chance to become ready.
  for attempt in {1..20}; do
    if [[ $(/usr/bin/curl --noproxy '*' --max-time 3 -s -o /dev/null -w '%{http_code}' https://lab.example.com/login) == 200 ]]; then ready=1; break; fi
    sleep 1
  done
  ((ready))
  [[ $(/usr/bin/curl --noproxy '*' --max-time 15 -sS -o /dev/null -w '%{http_code}' https://lab.example.com/api/state) == 401 ]]
  python3 - <<'PY'
import subprocess
for port in (4317,4318):
    lines=subprocess.check_output(['ss','-H','-ltn',f'sport = :{port}'],text=True).splitlines()
    assert len(lines)==1 and lines[0].split()[3]==f'127.0.0.1:{port}', 'An application port is not loopback-only'
PY
}
assert_login() {
  python3 - <<'PY'
import http.client,json,pathlib,ssl,urllib.parse
values=dict(line.split(': ',1) for line in pathlib.Path('/root/account-region-lab-credentials.txt').read_text().splitlines())
assert len(values['Password'])>=24 and values['URL']=='https://lab.example.com'
connection=http.client.HTTPSConnection('lab.example.com',timeout=15,context=ssl.create_default_context())
connection.request('POST','/login',urllib.parse.urlencode({'username':values['Username'],'password':values['Password']}),
                   {'Origin':values['URL'],'Content-Type':'application/x-www-form-urlencoded'})
response=connection.getresponse(); response.read()
assert response.status==303, 'Generated credentials do not authenticate'
cookie=response.getheader('Set-Cookie')
assert cookie and 'Secure' in cookie and 'HttpOnly' in cookie
connection.request('GET','/api/state',headers={'Cookie':cookie.split(';',1)[0]})
response=connection.getresponse(); body=response.read()
assert response.status==200 and isinstance(json.loads(body)['profiles'],list), 'Authenticated state is unavailable'
connection.close()
print('Generated workbench credentials authenticate over verified HTTPS.')
PY
}
assert_secret_not_logged() {
  python3 - "$WORK" <<'PY'
import pathlib,sys
receipt=pathlib.Path('/root/account-region-lab-credentials.txt')
password=dict(line.split(': ',1) for line in receipt.read_text().splitlines())['Password'].encode()
for log in pathlib.Path(sys.argv[1]).glob('*.log'):
    assert password not in log.read_bytes(), 'The generated password was exposed in a private test log'
PY
}
run_install() {
  local log=$1
  shift
  # Invoke the real executable script, rather than sourcing/replacing its helper
  # functions. The installer resolves and downloads this exact published commit.
  bash "$REPO/deploy/linux/install.sh" --host lab.example.com --ref "$REF" "$@" > "$log" 2>&1
}
chrome_failure_details() {
  # This browser visits only synthetic local HTML. Show a bounded, scrubbed
  # diagnostic excerpt without exposing complete logs, inherited env or secrets.
  python3 - "$WORK/chrome.log" "$RECEIPT" <<'PY'
import pathlib,re,sys
receipt=pathlib.Path(sys.argv[2])
password=dict(line.split(': ',1) for line in receipt.read_text().splitlines()).get('Password','')
shown=0
for line in pathlib.Path(sys.argv[1]).read_text(errors='replace').splitlines():
    if not re.search(r'FATAL|ERROR|sandbox|SIG',line,re.I): continue
    if password: line=line.replace(password,'[redacted]')
    line=re.sub(r'(?:https?|wss?|socks5?)://[^\s<>]+|data:[^\s]+','[URL]',line,flags=re.I)
    line=re.sub(r'[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}','[email]',line,flags=re.I)
    line=re.sub(r'\b(?:\d{1,3}\.){3}\d{1,3}\b','[IP]',line)
    line=re.sub(r'[\x00-\x1f\x7f]',' ',line)
    print(line[:500])
    shown+=1
    if shown==12: break
if not shown: print('Chrome produced no matching FATAL/ERROR/sandbox/SIG diagnostic lines.')
PY
}

progress 'creating temporary local TLS trust'
install -d -m 0755 "$ROOT" "$ROOT/certbot" "$ROOT/certbot/bin"
install -d -m 0700 "$ROOT/ci-fixture"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Account Region Lab disposable CI CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$ROOT/ci-fixture/ca.key" -out "$ROOT/ci-fixture/ca.crt" > "$WORK/tls.log" 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=lab.example.com' \
  -keyout "$ROOT/ci-fixture/leaf.key" -out "$ROOT/ci-fixture/leaf.csr" >> "$WORK/tls.log" 2>&1
printf '%s\n' 'subjectAltName=DNS:lab.example.com' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' > "$ROOT/ci-fixture/leaf.ext"
openssl x509 -req -in "$ROOT/ci-fixture/leaf.csr" -CA "$ROOT/ci-fixture/ca.crt" -CAkey "$ROOT/ci-fixture/ca.key" \
  -CAcreateserial -days 2 -extfile "$ROOT/ci-fixture/leaf.ext" -out "$ROOT/ci-fixture/leaf.crt" >> "$WORK/tls.log" 2>&1
install -m 0644 "$ROOT/ci-fixture/ca.crt" "$TRUST"
update-ca-certificates >> "$WORK/tls.log" 2>&1
cp -- /etc/hosts "$WORK/hosts.original"
printf '\n127.0.0.1 lab.example.com\n' >> /etc/hosts

# This narrow stub replaces ACME issuance only. It does not skip TLS validation:
# nginx serves a real SAN certificate and curl/Python use the trusted test CA.
cat > "$ROOT/certbot/bin/certbot" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
fixture=/opt/account-region-lab/ci-fixture
case ${1:-} in
  certonly)
    domain=''; directory=''; name=''; webroot=''
    shift
    while (($#)); do
      case "$1" in
        --domain) domain=$2; shift 2;;
        --config-dir) directory=$2; shift 2;;
        --cert-name) name=$2; shift 2;;
        --webroot-path) webroot=$2; shift 2;;
        --work-dir|--logs-dir) shift 2;;
        --non-interactive|--agree-tos|--register-unsafely-without-email|--keep-until-expiring|--webroot) shift;;
        *) printf '%s\n' 'Unexpected ACME fixture argument.' >&2; exit 1;;
      esac
    done
    [[ $domain == lab.example.com && $directory == /opt/account-region-lab/acme/config && $name == account-region-lab && $webroot == /var/www/account-region-lab-acme ]]
    install -d -m 0700 "$directory/live/$name"
    cat "$fixture/leaf.crt" "$fixture/ca.crt" > "$directory/live/$name/fullchain.pem"
    install -m 0600 "$fixture/leaf.key" "$directory/live/$name/privkey.pem"
    ;;
  renew) printf 'renew\n' >> "$fixture/renewals";;
  *) printf '%s\n' 'Unexpected ACME fixture command.' >&2; exit 1;;
esac
SH
cat > "$ROOT/certbot/bin/pip" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# == 3 && $1 == -q && $2 == install && $3 == 'certbot>=5.4,<7' ]]
# Prevent the real pip install from replacing this run's ACME-only fixture.
SH
chmod 0755 "$ROOT/certbot/bin/certbot" "$ROOT/certbot/bin/pip"

progress 'fresh installation'
run_install "$WORK/install.log" --max-environments 2
assert_healthy
assert_login
[[ $(stat -c %a "$RECEIPT") == 600 && $(stat -c %U "$RECEIPT") == root ]]
[[ $(stat -c %a "$DATA_HOME/access.json") == 600 && $(stat -c %U "$DATA_HOME/access.json") == regionlab ]]
[[ $(stat -c %a "$DATA_HOME/data") == 700 ]]
[[ $(dpkg-query -W -f='${Architecture}' google-chrome-stable) == amd64 ]]
[[ $("$ROOT/node/bin/node" -p 'process.versions.node.split(".")[0]') == 24 ]]
[[ $(cat "$ROOT/deployed-commit") == "$REF" ]]
systemctl start account-region-lab-certificate.service
[[ -s $ROOT/ci-fixture/renewals ]]

progress 'non-root Chrome with its sandbox enabled'
install -d -o regionlab -g regionlab -m 0700 "$DATA_HOME/ci-chrome-smoke" "$DATA_HOME/.config" "$DATA_HOME/.cache"
chrome_status=0
(
  cd -- "$DATA_HOME"
  # A clean allowlisted environment avoids runner-specific Chrome overrides and
  # root XDG paths. Crash reporting and caches must be writable by regionlab too.
  runuser -u regionlab -- env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
    HOME="$DATA_HOME" USER=regionlab LOGNAME=regionlab \
    XDG_CONFIG_HOME="$DATA_HOME/.config" XDG_CACHE_HOME="$DATA_HOME/.cache" XDG_RUNTIME_DIR=/run/account-region-lab \
    timeout --kill-after=5s 45s /usr/bin/google-chrome --headless --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$DATA_HOME/ci-chrome-smoke" --dump-dom 'data:text/html,<title>arl-ci-rendered</title><p>Local browser test</p>'
) > "$WORK/chrome.log" 2>&1 || chrome_status=$?
if ((chrome_status)); then
  printf 'Non-root Chrome exited with status %s. Sanitized diagnostic excerpt:\n' "$chrome_status" >&2
  chrome_failure_details >&2
  exit "$chrome_status"
fi
if ! grep -Fq '<title>arl-ci-rendered</title>' "$WORK/chrome.log"; then
  chrome_failure_details >&2
  printf '%s\n' 'Chrome did not return the synthetic HTML document.' >&2
  exit 1
fi

progress 'reinstallation preserves credentials and private data'
printf '%s\n' 'installer-ci-data-preservation-canary' > "$DATA_HOME/data/installer-ci-canary"
chown regionlab:regionlab "$DATA_HOME/data/installer-ci-canary"
sha256sum "$RECEIPT" "$DATA_HOME/access.json" "$DATA_HOME/data/installer-ci-canary" > "$WORK/preserved.sha256"
run_install "$WORK/reinstall.log"
sha256sum --check --status "$WORK/preserved.sha256"
grep -Fxq 'REGION_LAB_MAX_ENVIRONMENTS=2' /etc/account-region-lab.env
assert_healthy
assert_login

progress 'failure after activation restores the previous application and services'
# A file unique to the currently installed tree proves that rollback restores
# the old tree, even though the release ref is intentionally unchanged.
printf '%s\n' 'installer-ci-previous-release' > "$ROOT/app/.installer-ci-release-canary"
sha256sum "$ROOT/app/.installer-ci-release-canary" /etc/account-region-lab.env \
  /etc/nginx/sites-available/account-region-lab /etc/systemd/system/account-region-lab.service \
  /etc/systemd/system/account-region-lab-gateway.service /etc/systemd/system/account-region-lab-certificate.timer \
  "$ROOT/deployed-commit" > "$WORK/rollback.sha256"
install -d -m 0700 "$ROOT/ci-fixture/bin"
cat > "$ROOT/ci-fixture/bin/curl" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
for argument in "$@"; do
  if [[ $argument == https://lab.example.com/login && -f /opt/account-region-lab/ci-fixture/fail-https ]]; then
    mv /opt/account-region-lab/ci-fixture/fail-https /opt/account-region-lab/ci-fixture/failure-consumed
    # Simulate the final TLS verifier rejecting the just-activated release.
    printf '000'; exit 60
  fi
done
exec /usr/bin/curl "$@"
SH
chmod 0700 "$ROOT/ci-fixture/bin/curl"
touch "$ROOT/ci-fixture/fail-https"
if PATH="$ROOT/ci-fixture/bin:$PATH" run_install "$WORK/rollback.log"; then
  printf '%s\n' 'The deliberately failed installation unexpectedly succeeded.' >&2
  exit 1
fi
[[ -f $ROOT/ci-fixture/failure-consumed ]]
grep -Fq 'HTTPS login check failed' "$WORK/rollback.log"
sha256sum --check --status "$WORK/preserved.sha256"
sha256sum --check --status "$WORK/rollback.sha256"
assert_healthy
assert_login
assert_secret_not_logged
progress 'passed: amd64 install, verified HTTPS, authentication, Chrome, preservation and rollback'
