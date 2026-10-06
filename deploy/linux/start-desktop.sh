#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $(id -u) -eq 0 ]]; then
  printf '%s\n' 'Run the desktop as the dedicated non-root regionlab user.' >&2
  exit 1
fi

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${RUNTIME_DIRECTORY:-/run/account-region-lab}"
export XAUTHORITY="${XAUTHORITY:-$XDG_RUNTIME_DIR/Xauthority}"
if [[ ! $DISPLAY =~ ^:[0-9]+$ || $XAUTHORITY != "$XDG_RUNTIME_DIR/Xauthority" || ! -d $XDG_RUNTIME_DIR || -L $XAUTHORITY ]]; then
  printf '%s\n' 'The private desktop runtime directory or X authority path is invalid.' >&2
  exit 1
fi

for binary in Xvfb xauth xdpyinfo openbox x11vnc websockify mcookie curl python3 systemd-notify; do
  if ! command -v "$binary" >/dev/null; then
    printf 'Missing desktop dependency: %s\n' "$binary" >&2
    exit 1
  fi
done

pids=()
cleanup() {
  local status=$?
  trap - EXIT TERM INT
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  # systemd also kills the whole control group. Bound standalone cleanup so a
  # component that ignores SIGTERM cannot leave this launcher waiting forever.
  for ((attempt=0; attempt<50; attempt++)); do
    local running=0
    for pid in "${pids[@]}"; do if kill -0 "$pid" 2>/dev/null; then running=1; fi; done
    ((running)) || break
    sleep 0.1
  done
  for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  exit "$status"
}
trap cleanup EXIT
trap 'exit 0' TERM INT

install -m 0600 /dev/null "$XAUTHORITY"
cookie=$(mcookie)
printf 'add %s MIT-MAGIC-COOKIE-1 %s\n' "$DISPLAY" "$cookie" | xauth -f "$XAUTHORITY" source -
unset cookie

Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -auth "$XAUTHORITY" -noreset &
pids+=("$!")
display_ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then display_ready=1; break; fi
  if ! kill -0 "${pids[0]}" 2>/dev/null; then break; fi
  sleep 0.1
done
if (( ! display_ready )); then
  printf '%s\n' 'Xvfb did not become ready with the private X authority.' >&2
  exit 1
fi

openbox --sm-disable &
pids+=("$!")
x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -listen 127.0.0.1 -rfbport 5901 -localhost -forever -shared -nopw -noxdamage -repeat &
pids+=("$!")
websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901 &
pids+=("$!")

desktop_ready=0
for ((attempt=0; attempt<40; attempt++)); do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' 'A desktop component exited during startup.' >&2
      exit 1
    fi
  done
  if curl --noproxy '*' --silent --fail --max-time 0.3 http://127.0.0.1:6080/vnc.html -o /dev/null &&
      python3 -c 'import socket; s = socket.create_connection(("127.0.0.1", 5901), timeout=0.3); s.close()' 2>/dev/null; then
    desktop_ready=1
    break
  fi
  sleep 0.1
done
if (( ! desktop_ready )); then
  printf '%s\n' 'The loopback noVNC service did not become ready.' >&2
  exit 1
fi

if [[ -n ${NOTIFY_SOCKET:-} ]]; then systemd-notify --ready --status='Private desktop ready'; fi
# Any component exit, even status 0, invalidates the shared desktop. A failed
# service restarts the stack; it must never advertise a partially working UI.
wait -n "${pids[@]}" || true
printf '%s\n' 'A desktop component stopped; restarting the desktop is required.' >&2
exit 1
