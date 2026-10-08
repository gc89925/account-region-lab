# Account Region Lab

A local workbench for your own browser profiles, fixed proxy routes, environment diagnostics, and Google country-association observations.

**This does not change Google account country, verify residential IPs, or hide browser automation.** Seven days is an observation interval, not a Google eligibility rule.

## Run

Install Node.js 24, Chrome or Edge, and make `curl` available.

```bash
git clone https://github.com/gc89925/account-region-lab.git
cd account-region-lab
npm ci --ignore-scripts
npm start
```

Open `http://127.0.0.1:4317`. The interface is currently Chinese. India and Nigeria are unconfigured starting profiles. Configure your own HTTP/SOCKS5 endpoint, then diagnose the route before opening an account. Enter Google passwords only into Google's actual browser page. On Windows, SOCKS5 proxy credentials have separate fields and are encrypted using current-user DPAPI; the browser uses a loopback authentication bridge. HTTP authentication and other operating systems currently require a local proxy client.

## Features

- Paste a SOCKS5 URI or `host:port:username:password` into the proxy field. Multiple rows get a masked selection list; recognizable concatenated IPRoyal session exports are split safely. The IPRoyal gateway on port 12321 defaults to SOCKS5; unknown raw endpoints require a protocol choice. `country-id` means Indonesia, not India. Detected countries require an explicit apply action.
- Close a server or managed environment to clear or replace an expired proxy without deleting its login directory. Changing network settings resets stale IP bindings and checks while retaining observations. Running environments remain locked. Local native browsers cannot be reliably tracked and retain their original restrictions.
- Independent persistent browser directories and per-profile proxies.
- Server mode supports up to five simultaneous environments, each with a private display, native Chrome process and proxy. Open each viewer in a separate tab, or switch the embedded viewer without stopping other environments. The configured ceiling is not a guarantee that a small server can sustain five heavy pages.
- Actionable authentication/protocol/target diagnostics and explicitly applied protocol suggestions, with no direct-network fallback.
- Search all ISO countries with supply counts from the full global directory. Default batches of 60 (up to 200) use at most 12 fast connection checks and four full country/Google checks, with incremental results and cancellation. Sources load in parallel and cached lists stay visible while refreshing. The default results view only includes checks passed within two minutes. No verified residential IP supply is promised.
- Country checks and a GET request to the exact selected Google destination through the same proxy before each external launch; a matching country alone does not allow launch. The request does not follow redirects and 2xx/3xx only proves point-in-time URL reachability. Optional strict IP pinning blocks a changed IP even in the same country. This is not continuous network enforcement or proof of a rendered page/sign-in.
- Native Chrome/Edge mode, or experimental Playwright-managed mode with locale, timezone, viewport and color-scheme settings. Managed mode does not hide `navigator.webdriver` and may be incompatible with Google sign-in.
- Local diagnostics comparing requested and observed settings without network, telemetry or STUN requests.
- Official Google device-page guidance and user-confirmed review records. No personal-Gmail bulk sign-out API is implemented.
- Same-account-code exclusion between active managed profiles, within this application only.
- On-demand VPN Gate metadata with bounded downloads, caching and unverified residential-status labels. Nodes need a VPN client/fanout bridge to become a SOCKS5 endpoint.
- Observation history, seven-day review intervals, and exports with proxy endpoints, IPs and local account codes removed.

## Boundaries and storage

Profiles are not VMs. The app does not spoof Canvas/WebGL, fabricate activity, bypass login challenges, or submit country appeals. Google may use signals unrelated to the current proxy.

Data lives in the OS user application-data directory outside the source checkout. Set `REGION_LAB_DATA_DIR`, `BROWSER_PATH` or `PORT` when necessary. Never publish cookies, profiles, emails, proxy credentials or personal notes. Passwords and encrypted credential data are omitted from API responses, exports and browser arguments; usernames are visible only in local settings and omitted from exports. DPAPI data must be re-entered on another Windows account/machine. Stopping the service interrupts authenticated proxy bridges; restarting restores their saved local ports. Managed downloads may be cleaned up when the context closes; save important files yourself.

## Development

Run `npm test`. Tests do not require Google credentials or real proxies. See [contributing](../CONTRIBUTING.md), [security](../SECURITY.md), [verification](verification.md), and [the Chinese guide](../README.md).

MIT licensed. Inspired in part by [byJoey/fanout](https://github.com/byJoey/fanout); no source from that project is copied. Stars and real-world bug reports are welcome if you find the project useful.
