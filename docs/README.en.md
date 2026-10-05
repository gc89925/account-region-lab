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

Open `http://127.0.0.1:4317`. The interface is currently Chinese. India and Nigeria are unconfigured starting profiles. Configure your own HTTP/SOCKS5 endpoint, then check the route before opening an account. Enter passwords only into Google's actual browser page.

## Features

- Independent persistent browser directories and per-profile proxies.
- Country checks before each external launch; optional strict IP pinning blocks a changed IP even in the same country. This is not continuous network enforcement.
- Native Chrome/Edge mode, or experimental Playwright-managed mode with locale, timezone, viewport and color-scheme settings. Managed mode does not hide `navigator.webdriver` and may be incompatible with Google sign-in.
- Local diagnostics comparing requested and observed settings without network, telemetry or STUN requests.
- Official Google device-page guidance and user-confirmed review records. No personal-Gmail bulk sign-out API is implemented.
- Same-account-code exclusion between active managed profiles, within this application only.
- On-demand VPN Gate metadata with bounded downloads, caching and unverified residential-status labels. Nodes need a VPN client/fanout bridge to become a SOCKS5 endpoint.
- Observation history, seven-day review intervals, and exports with proxy endpoints, IPs and local account codes removed.

## Boundaries and storage

Profiles are not VMs. The app does not spoof Canvas/WebGL, fabricate activity, bypass login challenges, or submit country appeals. Google may use signals unrelated to the current proxy.

Data lives in the OS user application-data directory outside the source checkout. Set `REGION_LAB_DATA_DIR`, `BROWSER_PATH` or `PORT` when necessary. Never publish cookies, profiles, emails, proxy credentials or personal notes. Managed downloads may be cleaned up when the context closes; save important files yourself.

## Development

Run `npm test`. Tests do not require Google credentials or real proxies. See [contributing](../CONTRIBUTING.md), [security](../SECURITY.md), [verification](verification.md), and [the Chinese guide](../README.md).

MIT licensed. Inspired in part by [byJoey/fanout](https://github.com/byJoey/fanout); no source from that project is copied. Stars and real-world bug reports are welcome if you find the project useful.
