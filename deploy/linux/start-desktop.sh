#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $(id -u) -eq 0 ]]; then
  printf '%s\n' 'Run the desktop as the dedicated non-root regionlab user.' >&2
  exit 1
fi

export DISPLAY="${REGION_LAB_DISPLAY:?An isolated display is required}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:?A private runtime directory is required}"
export XAUTHORITY="${XAUTHORITY:?A private X authority path is required}"
vnc_port="${REGION_LAB_VNC_PORT:?An isolated VNC port is required}"
desktop_port="${REGION_LAB_DESKTOP_PORT:?An isolated desktop port is required}"
if [[ ! $DISPLAY =~ ^:20[0-4]$ || ! $vnc_port =~ ^590[2-6]$ || ! $desktop_port =~ ^610[1-5]$ ||
      $XDG_RUNTIME_DIR != /* || $XAUTHORITY != "$XDG_RUNTIME_DIR/Xauthority" || ! -d $XDG_RUNTIME_DIR ||
      -L $XDG_RUNTIME_DIR || -L $XAUTHORITY || $(stat -c %u "$XDG_RUNTIME_DIR") != "$(id -u)" ||
      $(stat -c %a "$XDG_RUNTIME_DIR") != 700 ]]; then
  printf '%s\n' 'The private desktop runtime directory or X authority path is invalid.' >&2
  exit 1
fi

desktop_backend="${REGION_LAB_DESKTOP_BACKEND-x11vnc}"
frame_rate="${REGION_LAB_DESKTOP_FRAME_RATE-20}"
case "$desktop_backend" in
  x11vnc) backend_binaries=(Xvfb x11vnc) ;;
  tigervnc) backend_binaries=(Xtigervnc) ;;
  *)
    printf '%s\n' 'REGION_LAB_DESKTOP_BACKEND must be x11vnc or tigervnc.' >&2
    exit 1
    ;;
esac
if [[ ! $frame_rate =~ ^([5-9]|[12][0-9]|30)$ ]]; then
  printf '%s\n' 'REGION_LAB_DESKTOP_FRAME_RATE must be an integer between 5 and 30.' >&2
  exit 1
fi

for binary in "${backend_binaries[@]}" xauth xdpyinfo openbox websockify mcookie curl python3 timeout; do
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
  # The controller also owns this launcher's POSIX process group. Bound this
  # cleanup so a component that ignores SIGTERM cannot hang the environment.
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

if [[ $desktop_backend == tigervnc ]]; then
  # Xtigervnc owns the X display and RFB server together. Keep the geometry,
  # private X authority and loopback-only gateway path identical across backends.
  Xtigervnc "$DISPLAY" -geometry 1280x800 -depth 24 -nolisten tcp -auth "$XAUTHORITY" -noreset \
    -localhost -interface 127.0.0.1 -UseIPv6=0 -rfbport "$vnc_port" \
    -SecurityTypes None -AlwaysShared -FrameRate "$frame_rate" -CompareFB 2 >&2 &
else
  Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -auth "$XAUTHORITY" -noreset >&2 &
fi
pids+=("$!")
display_ready=0
display_deadline=$((SECONDS + 8))
while ((SECONDS < display_deadline)); do
  # XOpenDisplay can block while the X server initializes. A loop counter alone
  # does not bound startup when the probe itself never returns.
  if timeout --signal=TERM --kill-after=0.2s 1s xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then display_ready=1; break; fi
  if ! kill -0 "${pids[0]}" 2>/dev/null; then break; fi
  sleep 0.1
done
if (( ! display_ready )); then
  printf '%s\n' 'The X server did not become ready with the private X authority.' >&2
  exit 1
fi

openbox --sm-disable >&2 &
pids+=("$!")
if [[ $desktop_backend == x11vnc ]]; then
  x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -listen 127.0.0.1 -rfbport "$vnc_port" -localhost -forever -shared -nopw -noxdamage -repeat -wait 50 -defer 50 >&2 &
  pids+=("$!")
fi
websockify --web /usr/share/novnc "127.0.0.1:$desktop_port" "127.0.0.1:$vnc_port" >&2 &
pids+=("$!")

desktop_ready=0
desktop_deadline=$((SECONDS + 30))
while ((SECONDS < desktop_deadline)); do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' 'A desktop component exited during startup.' >&2
      exit 1
    fi
  done
  if curl --noproxy '*' --silent --fail --max-time 1 "http://127.0.0.1:$desktop_port/vnc.html" -o /dev/null &&
      timeout --signal=TERM --kill-after=0.2s 1s python3 -c 'import socket, sys; s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=0.3); s.close()' "$vnc_port" 2>/dev/null; then
    desktop_ready=1
    break
  fi
  sleep 0.1
done
if (( ! desktop_ready )); then
  printf '%s\n' 'The loopback noVNC service did not become ready.' >&2
  exit 1
fi

printf '%s\n' 'REGION_LAB_DESKTOP_READY'
# Any component exit invalidates only this environment's desktop. The manager
# closes its browser and releases the slot after all owned processes stop.
wait -n "${pids[@]}" || true
printf '%s\n' 'A desktop component stopped; restarting the desktop is required.' >&2
exit 1
