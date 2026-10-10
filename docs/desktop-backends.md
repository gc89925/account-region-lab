# Linux remote desktop backends

Each browser environment uses its own X display, X authority, browser profile,
loopback VNC port and authenticated gateway route. The desktop backend can be
selected independently of the browser and proxy settings.

## Configuration

The controller inherits these optional settings from its environment, normally
`/etc/account-region-lab.env` in the systemd deployment:

```ini
REGION_LAB_DESKTOP_BACKEND=tigervnc
REGION_LAB_DESKTOP_FRAME_RATE=20
```

`REGION_LAB_DESKTOP_BACKEND` accepts exactly `x11vnc` or `tigervnc`. When absent,
it defaults to the existing `x11vnc` stack. An empty or unknown value is rejected.
`REGION_LAB_DESKTOP_FRAME_RATE` accepts an integer from 5 to 30, defaults to 20,
and only affects TigerVNC. It is a maximum update rate, not a promised frame
rate. Invalid values are rejected for either backend.

Apply service environment changes when existing browser environments can be
closed. Restarting the controller closes its running browser and desktop
processes; saved browser profiles and proxy settings remain on disk. Reopen the
desired environments after restarting the service.

## Dependencies and behavior

The default backend uses Xvfb, Openbox, x11vnc and websockify. Its existing
1280×800, 24-bit display and x11vnc polling settings are unchanged.

TigerVNC replaces Xvfb and x11vnc with one `Xtigervnc` process. Openbox and
websockify remain. On Ubuntu 24.04, inspect and install the distribution package:

```bash
apt-get -s install --no-install-recommends tigervnc-standalone-server
apt-get install --no-install-recommends -y tigervnc-standalone-server
```

The Ubuntu Noble manual documents `tigervnc-standalone-server`
1.13.1+dfsg-2build2. Verify the installed version and available options on the
deployment host. The launcher starts `Xtigervnc` directly as the existing
non-root service user; it does not use the `tigervncserver` wrapper, create a
separate login session, or start another system service.

Both backends use 1280×800 at 24-bit depth, displays `:200`–`:204`, RFB ports
5902–5906 and websockify ports 6101–6105. X11 TCP is disabled. X clients require
the environment's private MIT-MAGIC-COOKIE-1 authority file. RFB and websockify
listen only on IPv4 loopback; the HTTPS gateway authenticates external access.
RFB itself uses no password on that internal hop, matching the original stack.
Do not expose these ports publicly.

The controller's existing process group owns every desktop component. Startup
uses the same bounded X display and noVNC readiness checks and exact
`REGION_LAB_DESKTOP_READY` marker. A component exit invalidates that environment;
shutdown sends TERM, waits for bounded cleanup, and uses KILL if necessary before
the slot can be reused.

## Compare with the same workload

Changing the backend may reduce screen capture and VNC encoding overhead. It
does not remove Chrome's page rendering, JavaScript or memory requirements.
Measure before choosing a deployment default.

1. Use the same Chrome version and launch flags, display geometry, proxy and
   comparable fresh profiles. Test the same public Google or Gmail login page
   without reading private account content.
2. Connect an actual noVNC viewer. Compare viewer-disconnected idle,
   viewer-connected idle, initial navigation and the same scrolling/input work.
   A background browser test alone misses active capture and encoding costs.
3. Record wall time and process CPU time deltas. Report browser-tree and
   desktop-tree PSS separately, along with swap-in/out, major page faults and
   virtual-machine steal time. A single lifetime CPU percentage is insufficient.
4. Test one environment, then two concurrent environments, under the same other
   server workload. Keep viewer quality/compression settings unchanged for the
   first comparison.
5. Check actual rendering, pointer and keyboard input, clipboard behavior,
   independent environment closure, generation changes and complete process/port
   cleanup.

The Linux launcher tests use component substitutes to validate arguments,
selection, readiness and process cleanup without requiring an installed GUI.
They are not rendering or performance benchmarks. They run under a non-root
Linux user, matching deployment.

## Primary references

- [Ubuntu Noble Xtigervnc manual](https://manpages.ubuntu.com/manpages/noble/man1/Xtigervnc.1.html)
- [Ubuntu Noble Xserver manual](https://manpages.ubuntu.com/manpages/noble/man1/Xserver.1.html)
- [noVNC server requirements](https://github.com/novnc/noVNC#server-requirements)
- [noVNC RFB implementation](https://github.com/novnc/noVNC/blob/master/core/rfb.js)
