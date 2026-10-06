# Changelog

## 0.3.2 — 2026-10-06

- Require a GET connectivity check of the selected Google destination, through the same proxy, before every external browser launch. Matching exit country alone is insufficient.
- Network checks include the Google sign-in endpoint; failed destination checks remain visible and do not launch a browser or create a new IP binding/cycle.
- Preserve upstream SOCKS target rejection details and the caller's timeout cause. Launch feedback distinguishes a sent request from a rendered page or a signed-in account.

## 0.3.1 — 2026-10-06

- Pasting an authenticated SOCKS5 URI splits its address, decoded username and password into separate settings fields without displaying credentials in feedback.
- Settings, observation and device-review dialogs remain open when their backdrop is clicked, preserving in-progress inputs.

## 0.3.0 — 2026-10-06

- SOCKS5 username/password fields with Windows current-user DPAPI storage and a loopback authentication bridge for native and managed browsers.
- Precise sanitized proxy diagnostics, explicit tested protocol suggestions, and bounded fallback between HTTPS geolocation providers.
- Bounded automatic public-proxy batches with progress, cancellation, rotating candidates and a default recently verified results view.

## 0.2.2 — 2026-10-06

- Background launcher, explicit Stop/Status commands, persistent service logs, and a shared local data-directory configuration.
- Workspace and instance checks prevent reusing or stopping an unrelated process.
- Optional current-user Windows logon task with bounded failure restart and an uninstall command.

## 0.2.1 — 2026-10-05

- Explicit Google sign-in action, missing-proxy setup guidance, persistent action feedback, and visible device-dialog errors.
- Global public-node list with country counts and popular-country filters, distinguishing empty results from source failures.
- Automatic browser opening from the launcher; early native-browser exits and proxy errors now have actionable messages.
- Failed managed navigations retain their page for inspection; copied environments use fresh browser storage.

## 0.2.0 — 2026-10-05

- Official Google device-management assistant and user-confirmed review records.
- Optional strict IP binding, with country/IP drift blocking before external launches.
- Managed Chrome/Edge contexts with locale, timezone, viewport, color scheme, lifecycle controls and per-account-code exclusion.
- Local diagnostics and report export, preserving visible automation status.
- On-demand VPN Gate directory with bounded requests, validation, caching and unverified residential labels.
- fanout integration docs, English guide, contribution/security guidance and Windows/Linux test CI.
- Preserve v0.1 records and existing profiles' native behavior.

## 0.1.0 — 2026-10-05

- Initial profile isolation, proxy-country checks, Google shortcuts and seven-day observation records.
