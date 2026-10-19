#!/usr/bin/env bash
# Account Region Lab installer. No proxy or Google account credentials are needed.
set -Eeuo pipefail
umask 022

REPOSITORY=gc89925/account-region-lab
DEFAULT_REF=v0.10.0
NODE_VERSION=v24.21.0
ROOT=/opt/account-region-lab
DATA_HOME=/var/lib/account-region-lab
ENV_FILE=/etc/account-region-lab.env
VHOST=/etc/nginx/sites-available/account-region-lab
HOST=''
REF=$DEFAULT_REF
USERNAME=admin
LIMIT=''
CHECK_ONLY=0
WORK=''
BACKUP=''
SWITCHED=0
ACTIVATION_STARTED=0
HAD_APP=0
WAS_ACTIVE=0

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Account Region Lab: Ubuntu 24.04 server installer (amd64 / arm64)

sudo bash install.sh --host YOUR_PUBLIC_IP_OR_DOMAIN
sudo bash install.sh                         # reuse the installed host, or prompt
sudo bash install.sh --host lab.example.com --max-environments 3
bash install.sh --host lab.example.com --check

Options:
  --host HOST             Public IPv4 or domain; no scheme, path or port.
  --ref REF               Release tag, branch or commit (default: v0.10.0).
  --username NAME         Initial workbench user (default: admin).
  --max-environments N    1 to 5; existing value is preserved when omitted.
  --check                Read-only validation; do not install or restart anything.
  --help                 Show this help.

Open inbound TCP 80 and 443 in your cloud firewall before installation.
DNS must already point to this server when using a domain. HTTPS is required.
New passwords are random and saved only in /root/account-region-lab-credentials.txt.
Existing workbench credentials, proxy settings and browser profiles are preserved.
Upgrades briefly close running account browsers; reopen them from the workbench.
The installer does not change SSH, firewalls, swap, or other websites.
HELP
}
parse_args() {
  while (($#)); do
    case "$1" in
      --host|--ref|--username|--max-environments)
        (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || die "Missing value for $1"
        case "$1" in
          --host) HOST=$2;; --ref) REF=$2;; --username) USERNAME=$2;; --max-environments) LIMIT=$2;;
        esac
        shift 2;;
      --check) CHECK_ONLY=1; shift;;
      --help|-h) usage; return 10;;
      *) die "Unknown option: $1";;
    esac
  done
  [[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ && "$REF" != *..* && "$REF" != */ ]] || die 'Invalid release ref'
  [[ "$USERNAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || die 'Invalid workbench username'
  [[ -z "$LIMIT" || "$LIMIT" =~ ^[1-5]$ ]] || die '--max-environments must be between 1 and 5'
}
read_setting() {
  # Never source a configuration file as root.
  python3 - "$ENV_FILE" "$1" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); key=sys.argv[2]+'='
if p.is_file():
    values=[line[len(key):].strip() for line in p.read_text().splitlines() if line.startswith(key)]
    if len(values)>1: raise SystemExit('Duplicate installer setting')
    if values: print(values[0])
PY
}
validate_host() {
  python3 - "$1" <<'PY'
import ipaddress,re,sys
host=sys.argv[1].lower()
try:
    addr=ipaddress.ip_address(host)
    if addr.version!=4 or not addr.is_global: raise ValueError('Use a public IPv4 address')
    print('ip'); print(str(addr))
except ValueError:
    if ':' in host or re.fullmatch(r'[0-9.]+',host): raise SystemExit('Invalid public IP address')
    if len(host)>253 or '.' not in host or host.endswith(('.local','.localhost','.invalid','.test','.example')):
        raise SystemExit('Use a public DNS name or public IP address')
    if not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',p) for p in host.split('.')):
        raise SystemExit('Invalid hostname (use ASCII / punycode, without scheme, port or path)')
    print('domain'); print(host)
PY
}
fetch() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 300 "$@"; }
snapshot() {
  local path=$1
  if [[ -e "$path" || -L "$path" ]]; then
    mkdir -p "$BACKUP$(dirname "$path")"
    cp -a -- "$path" "$BACKUP$path"
  fi
  printf '%s\n' "$path" >> "$BACKUP/managed-paths"
}
restore_configs() {
  local path
  while IFS= read -r path; do
    if [[ -e "$BACKUP$path" || -L "$BACKUP$path" ]]; then
      cp -a --remove-destination -T -- "$BACKUP$path" "$path"
    else
      rm -f -- "$path"
    fi
  done < "$BACKUP/managed-paths"
}
cleanup() {
  local status=$?
  trap - EXIT
  if ((status != 0)) && [[ -n "$BACKUP" ]]; then
    say 'Installation failed. Restoring the previous application configuration.' >&2
    if [[ -f "$BACKUP/unit-states" ]]; then
      while read -r unit enabled active; do
        systemctl stop "$unit" || true
        systemctl disable "$unit" || true
      done < "$BACKUP/unit-states"
    elif ((ACTIVATION_STARTED)); then
      systemctl stop account-region-lab.service account-region-lab-gateway.service || true
    fi
    if ((SWITCHED)); then
      if [[ -d "$ROOT/app" ]]; then mv -- "$ROOT/app" "$BACKUP/failed-app"; fi
      if ((HAD_APP)); then mv -- "$BACKUP/previous-app" "$ROOT/app"; fi
    fi
    restore_configs || true
    systemctl daemon-reload || true
    if [[ -f "$BACKUP/unit-states" ]]; then
      while read -r unit enabled active; do
        if [[ "$enabled" == enabled ]]; then systemctl enable "$unit" || true; fi
        if [[ "$active" == active ]]; then systemctl start "$unit" || true; fi
      done < "$BACKUP/unit-states"
    elif ((WAS_ACTIVE)); then systemctl start account-region-lab.service account-region-lab-gateway.service || true; fi
    if nginx -t; then systemctl reload nginx || true; fi
    say "Rollback files: $BACKUP" >&2
  fi
  if [[ -n "$WORK" && "$WORK" == "$ROOT"/.install.* ]]; then rm -rf -- "$WORK"; fi
  exit "$status"
}
preflight() {
  [[ -f /etc/os-release ]] || die 'Ubuntu 24.04 is required'
  # This is the distribution-owned metadata file, not project configuration.
  . /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || die 'Supported OS: Ubuntu 24.04'
  case "$(dpkg --print-architecture)" in
    amd64) NODE_ARCH=x64; CHROME_ARCH=amd64;;
    arm64) NODE_ARCH=arm64; CHROME_ARCH=arm64;;
    *) die 'Supported architectures: amd64 and arm64';;
  esac
  command -v python3 >/dev/null || die 'Install python3 first: sudo apt-get install python3'
  if [[ -z "$HOST" && -f "$ENV_FILE" ]]; then
    HOST=$(read_setting REGION_LAB_PUBLIC_ORIGIN)
    HOST=${HOST#https://}; HOST=${HOST#[}; HOST=${HOST%]}
  fi
  if [[ -z "$HOST" ]]; then
    [[ -t 0 ]] || die 'Supply --host YOUR_PUBLIC_IP_OR_DOMAIN'
    read -r -p 'Public IP or domain for this server: ' HOST
  fi
  HOST=${HOST,,}
  local host_info
  host_info=$(validate_host "$HOST") || die 'Invalid --host value'
  HOST_KIND=${host_info%%$'\n'*}; ORIGIN_HOST=${host_info#*$'\n'}
  ORIGIN=https://$ORIGIN_HOST
  if [[ -z "$LIMIT" && -f "$ENV_FILE" ]]; then LIMIT=$(read_setting REGION_LAB_MAX_ENVIRONMENTS); fi
  LIMIT=${LIMIT:-5}
  [[ "$LIMIT" =~ ^[1-5]$ ]] || die 'Existing environment limit is invalid'
  [[ -d /run/systemd/system ]] || die 'A server booted with systemd is required'
  if systemctl is-active --quiet account-region-lab-desktop.service; then die 'Stop and disable the legacy shared-desktop service before upgrading'; fi
  local listener
  for port in 80 443; do
    listener=$(ss -H -ltnp "sport = :$port")
    if [[ -n "$listener" && "$listener" != *nginx* ]]; then die "Port $port is used by another web server; configure that conflict first"; fi
  done
  local path
  for path in "$ROOT" "$DATA_HOME" "$DATA_HOME/data" "$DATA_HOME/access.json" "$ENV_FILE" "$VHOST" "$ROOT/app" "$ROOT/releases" "$ROOT/backups"; do
    [[ ! -L "$path" ]] || die "Refusing symlink at managed path: $path"
  done
  for path in "$ROOT/node" "$ENV_FILE" "$VHOST" /etc/systemd/system/account-region-lab.service /etc/systemd/system/account-region-lab-gateway.service /etc/systemd/system/account-region-lab-certificate.service /etc/systemd/system/account-region-lab-certificate.timer; do
    [[ ! -d "$path" || -L "$path" ]] || die "Expected a file or managed symlink, not a directory: $path"
  done
  [[ ! -e "$ROOT/node" || -L "$ROOT/node" ]] || die 'Existing Node path must be a symlink; inspect the manual installation before continuing'
  if [[ -e /etc/nginx/sites-enabled/account-region-lab || -L /etc/nginx/sites-enabled/account-region-lab ]]; then
    [[ -L /etc/nginx/sites-enabled/account-region-lab && "$(readlink -f /etc/nginx/sites-enabled/account-region-lab)" == "$VHOST" ]] || die 'Existing enabled nginx entry is not the managed symlink'
  fi
  if id regionlab >/dev/null 2>&1; then
    [[ "$(getent passwd regionlab | cut -d: -f6)" == "$DATA_HOME" ]] || die 'Existing regionlab user has a different HOME'
    [[ "$(id -u regionlab)" != 0 ]] || die 'regionlab must not be root'
    getent group regionlab >/dev/null || die 'Existing regionlab account has no regionlab group'
  fi
  if [[ ! -d "$ROOT/app" ]]; then
    for port in 4317 4318; do
      [[ -z "$(ss -H -ltn "sport = :$port")" ]] || die "Port $port is already used by another application"
    done
  fi
  local ram
  ram=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  say "Plan: Ubuntu $VERSION_ID / $CHROME_ARCH; $ORIGIN; up to $LIMIT environments; ${ram} MiB RAM."
  if ((ram < 4096)); then say 'Small host: start with one browser. Multiple large pages need more CPU and RAM.'; fi
  say 'TCP 80/443 must be reachable. Existing proxy credentials and browser data will be kept.'
}
write_http_config() {
  # Preserve a working HTTPS vhost during ACME renewal / host changes.
  if [[ -f "$VHOST" ]] && grep -Fq "server_name $HOST;" "$VHOST" && grep -Fq '/var/www/account-region-lab-acme' "$VHOST"; then return; fi
  if [[ -f "$VHOST" ]]; then
    die 'An existing nginx host differs. Keep its --host or migrate the hostname manually before reinstalling.'
  fi
  cat > "$VHOST" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    location ^~ /.well-known/acme-challenge/ { root /var/www/account-region-lab-acme; default_type text/plain; try_files \$uri =404; }
    location / { return 301 $ORIGIN\$request_uri; }
}
NGINX
}
main() {
  local parsed=0
  parse_args "$@" || parsed=$?
  ((parsed != 10)) || return 0
  ((parsed == 0)) || return "$parsed"
  preflight
  if ((CHECK_ONLY)); then say 'Read-only checks passed. Public DNS/ACME reachability is checked during installation.'; return; fi
  ((EUID == 0)) || die 'Run installation with sudo or as root'
  command -v flock >/dev/null || die 'Install util-linux first'
  exec 9>/run/lock/account-region-lab-install.lock
  flock -n 9 || die 'Another Account Region Lab installation is running'
  install -d -m 0755 "$ROOT" "$ROOT/releases"
  install -d -m 0700 "$ROOT/backups"
  WORK=$(mktemp -d "$ROOT/.install.XXXXXXXX")
  trap cleanup EXIT
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
  say 'Installing system dependencies (other applications are not restarted)...'
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3-venv xvfb xauth x11-utils xclip xdotool openbox x11vnc novnc websockify fonts-noto-cjk fonts-noto-color-emoji nginx

  say 'Downloading the official architecture-specific Node and Chrome builds...'
  local node_name="node-$NODE_VERSION-linux-$NODE_ARCH"
  if [[ ! -x "$ROOT/$node_name/bin/node" ]]; then
    fetch "https://nodejs.org/dist/$NODE_VERSION/$node_name.tar.xz" -o "$WORK/node.tar.xz"
    fetch "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
    local expected
    expected=$(awk -v name="$node_name.tar.xz" '$2 == name {print $1}' "$WORK/SHASUMS256.txt")
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || die 'Node checksum is missing'
    printf '%s  %s\n' "$expected" "$WORK/node.tar.xz" | sha256sum -c -
    tar -xJf "$WORK/node.tar.xz" -C "$ROOT"
  fi
  NODE_BIN=$ROOT/$node_name/bin
  fetch "https://dl.google.com/linux/direct/google-chrome-stable_current_$CHROME_ARCH.deb" -o "$WORK/chrome.deb"
  [[ "$(dpkg-deb -f "$WORK/chrome.deb" Architecture)" == "$CHROME_ARCH" ]] || die 'Chrome package architecture mismatch'
  apt-get install -y --no-install-recommends "$WORK/chrome.deb"
  if [[ -f /etc/apparmor.d/chrome ]]; then apparmor_parser -r /etc/apparmor.d/chrome; fi

  say "Preparing application $REF..."
  fetch "https://api.github.com/repos/$REPOSITORY/commits/$REF" -o "$WORK/commit.json"
  local commit
  commit=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha"])' "$WORK/commit.json")
  [[ "$commit" =~ ^[a-f0-9]{40}$ ]] || die 'Invalid GitHub commit response'
  fetch "https://codeload.github.com/$REPOSITORY/tar.gz/$commit" -o "$WORK/app.tar.gz"
  mkdir "$WORK/source"
  python3 - "$WORK/app.tar.gz" "$WORK/source" <<'PY'
import tarfile,sys
with tarfile.open(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2],filter='data')
PY
  local staged=$WORK/source/account-region-lab-$commit
  [[ -f "$staged/server.js" && -f "$staged/deploy/linux/account-region-lab.service" ]] || die 'Incomplete application archive'
  (cd "$staged" && PATH="$NODE_BIN:$PATH" npm ci --ignore-scripts --omit=dev --no-audit --no-fund)
  [[ -x "$ROOT/certbot/bin/certbot" ]] || python3 -m venv "$ROOT/certbot"
  "$ROOT/certbot/bin/pip" -q install 'certbot>=5.4,<7'

  if ! id regionlab >/dev/null 2>&1; then useradd --system --user-group --create-home --home-dir "$DATA_HOME" --shell /usr/sbin/nologin regionlab; fi
  install -d -o regionlab -g regionlab -m 0700 "$DATA_HOME" "$DATA_HOME/data"
  if [[ ! -f "$DATA_HOME/access.json" ]]; then
    [[ ! -e /root/account-region-lab-credentials.txt && ! -L /root/account-region-lab-credentials.txt ]] || die 'Credential receipt already exists but access.json is missing; inspect before retrying'
    local password
    password=$("$NODE_BIN/node" --input-type=module -e 'import {randomBytes} from "node:crypto";console.log(randomBytes(24).toString("base64url"))')
    printf '%s\n' "$password" | "$NODE_BIN/node" "$staged/deploy/linux/create-access.mjs" "$DATA_HOME/access.json" "$USERNAME"
    chown regionlab:regionlab "$DATA_HOME/access.json"
    (umask 077; printf 'URL: %s\nUsername: %s\nPassword: %s\n' "$ORIGIN" "$USERNAME" "$password" > /root/account-region-lab-credentials.txt)
    unset password
  fi

  BACKUP=$(mktemp -d "$ROOT/backups/install.XXXXXXXX")
  chmod 0700 "$BACKUP"
  local path
  for path in "$ENV_FILE" "$VHOST" /etc/nginx/sites-enabled/account-region-lab "$ROOT/node" /etc/systemd/system/account-region-lab.service /etc/systemd/system/account-region-lab-gateway.service /etc/systemd/system/account-region-lab-certificate.service /etc/systemd/system/account-region-lab-certificate.timer; do snapshot "$path"; done
  local unit enabled active
  for unit in account-region-lab.service account-region-lab-gateway.service account-region-lab-certificate.timer; do
    enabled=$(systemctl is-enabled "$unit" 2>/dev/null) || true
    active=$(systemctl is-active "$unit" 2>/dev/null) || true
    printf '%s %s %s\n' "$unit" "${enabled:-not-found}" "${active:-inactive}" >> "$BACKUP/unit-states"
  done
  if systemctl is-active --quiet account-region-lab.service; then WAS_ACTIVE=1; fi
  install -d -m 0755 /var/www/account-region-lab-acme
  write_http_config
  chmod 0644 "$VHOST"
  ln -sfn "$VHOST" /etc/nginx/sites-enabled/account-region-lab
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
  local cert_args=(--domain "$HOST")
  if [[ "$HOST_KIND" == ip ]]; then cert_args=(--ip-address "$HOST" --preferred-profile shortlived); fi
  "$ROOT/certbot/bin/certbot" certonly --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring --webroot --webroot-path /var/www/account-region-lab-acme --config-dir "$ROOT/acme/config" --work-dir "$ROOT/acme/work" --logs-dir "$ROOT/acme/logs" --cert-name account-region-lab "${cert_args[@]}"

  say 'Activating the release; running account browsers will close briefly...'
  if [[ -d "$ROOT/app" ]]; then HAD_APP=1; fi
  ACTIVATION_STARTED=1
  if ((HAD_APP)); then systemctl stop account-region-lab.service account-region-lab-gateway.service; fi
  if ((HAD_APP)); then mv -- "$ROOT/app" "$BACKUP/previous-app"; fi
  SWITCHED=1
  mv -- "$staged" "$ROOT/app"
  chown -R root:root "$ROOT/app"
  chmod -R go-w "$ROOT/app"
  [[ ! -e "$ROOT/node" || -L "$ROOT/node" ]] || die 'Existing Node path must be a symlink'
  ln -sfn "$ROOT/$node_name" "$ROOT/node"
  # Keep unrelated supported environment settings, without evaluating them.
  python3 - "$ENV_FILE" "$ORIGIN" "$LIMIT" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); updates={'REGION_LAB_PUBLIC_ORIGIN':sys.argv[2], 'BROWSER_PATH':'/usr/bin/google-chrome', 'REGION_LAB_MAX_ENVIRONMENTS':sys.argv[3]}
lines=p.read_text().splitlines() if p.exists() else []
lines=[line for line in lines if line.split('=',1)[0] not in updates and not line.startswith('PORT=')]
p.write_text('\n'.join(lines+[key+'='+value for key,value in updates.items()])+'\n')
PY
  chown root:regionlab "$ENV_FILE"; chmod 0640 "$ENV_FILE"
  install -m 0644 "$ROOT/app/deploy/linux/account-region-lab.service" "$ROOT/app/deploy/linux/account-region-lab-gateway.service" /etc/systemd/system/
  cat > "$VHOST" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    location ^~ /.well-known/acme-challenge/ { root /var/www/account-region-lab-acme; default_type text/plain; try_files \$uri =404; }
    location / { return 301 $ORIGIN\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $HOST;
    ssl_certificate $ROOT/acme/config/live/account-region-lab/fullchain.pem;
    ssl_certificate_key $ROOT/acme/config/live/account-region-lab/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 32k;
    # Keep accepted clipboard JSON in memory instead of request-body temp files.
    client_body_buffer_size 32k;
    add_header Strict-Transport-Security "max-age=86400" always;
    location / {
        proxy_pass http://127.0.0.1:4318;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 13h;
        proxy_send_timeout 130s;
        proxy_buffering off;
    }
}
NGINX
  cat > /etc/systemd/system/account-region-lab-certificate.service <<UNIT
[Unit]
Description=Renew Account Region Lab HTTPS certificate
[Service]
Type=oneshot
ExecStart=$ROOT/certbot/bin/certbot renew --non-interactive --quiet --config-dir $ROOT/acme/config --work-dir $ROOT/acme/work --logs-dir $ROOT/acme/logs --deploy-hook "/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx"
UNIT
  cat > /etc/systemd/system/account-region-lab-certificate.timer <<'UNIT'
[Unit]
Description=Check Account Region Lab HTTPS renewal twice daily
[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=30m
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemd-analyze verify /etc/systemd/system/account-region-lab.service /etc/systemd/system/account-region-lab-gateway.service
  systemctl daemon-reload
  systemctl enable --now account-region-lab.service account-region-lab-gateway.service account-region-lab-certificate.timer
  nginx -t
  systemctl reload nginx
  local healthy=0
  for attempt in {1..20}; do
    if curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:4317/api/health > "$WORK/health.json" && "$NODE_BIN/node" -e 'const h=require(process.argv[1]);process.exit(h.app==="account-region-lab"&&h.ready===true?0:1)' "$WORK/health.json"; then healthy=1; break; fi
    sleep 1
  done
  ((healthy)) || die 'Application health check failed'
  [[ "$(curl --noproxy '*' --max-time 10 -sS -o /dev/null -w '%{http_code}' -H "Host: $ORIGIN_HOST" http://127.0.0.1:4318/api/state)" == 401 ]] || die 'Gateway authentication check failed'
  [[ "$(curl --noproxy '*' --max-time 15 --resolve "$HOST:443:127.0.0.1" -sS -o /dev/null -w '%{http_code}' "$ORIGIN/login")" == 200 ]] || die 'HTTPS login check failed'
  [[ "$(curl --noproxy '*' --max-time 15 --resolve "$HOST:443:127.0.0.1" -sS -o /dev/null -w '%{http_code}' "$ORIGIN/api/state")" == 401 ]] || die 'HTTPS authentication check failed'
  printf '%s\n' "$commit" > "$ROOT/deployed-commit"
  say "Installed successfully: $ORIGIN"
  say 'Login credentials: sudo cat /root/account-region-lab-credentials.txt (first automatic install only).'
  say 'If upgrading an existing manual install, use your existing workbench username and password.'
  say "Previous application/configuration backup: $BACKUP"
  say 'Browser data remains private in /var/lib/account-region-lab. Configure your own proxy in the workbench.'
  BACKUP=''
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
