# Security

This is an experimental, single-user application. The control API binds only to `127.0.0.1`. Local mode must not be exposed publicly. Server mode requires the authenticated gateway behind HTTPS; never proxy directly to the control API, noVNC or VNC ports.

- Browser profiles contain signed-in sessions. Keep the data directory outside the repository and under your own OS account.
- The control API validates Host, Origin and a per-process mutation token. This does not protect against malicious software already running as your OS user.
- Managed mode uses Playwright with your installed Chrome or Edge. It exposes no remote-debugging TCP endpoint; it is not a stealth browser or VM.
- The official VPN Gate directory is retrieved only on request. No directory node is automatically connected to or trusted as residential. The app does not execute downloaded VPN configurations.
- The proxy check contacts country.is (or bounded fallback ipwho.is) through the configured proxy. Catalog checks and explicit diagnostics also contact Google's login endpoint. It is a point-in-time check, not a system firewall or continuous network kill switch.
- Windows SOCKS5 credentials are encrypted with current-user DPAPI. Passwords are passed to the protector via stdin, never command arguments, and excluded from API responses and exports. A per-profile SOCKS5 bridge binds only to loopback, authenticates to the configured upstream and has no direct fallback; it is available to other processes on the same machine. Standard SOCKS5 username/password authentication does not itself encrypt the upstream transport. Use a trusted transport/provider.
- Linux server mode encrypts proxy credentials with AES-256-GCM and a private 0600 installation key. Back up the key with the encrypted data; it does not encrypt Chrome session files or protect against compromise of the service user.
- Remote access uses a separate scrypt password hash and random 12-hour Secure/HttpOnly/SameSite=Strict session cookies. API and desktop WebSockets require authentication; mutations and WebSockets require the exact configured HTTPS origin. Logging out revokes that web session and desktop connection, but leaves the account browser running until explicitly closed.
- The server desktop runs native Chrome as a non-root user with its sandbox enabled, behind a private X authority. One account environment runs at a time. This is session isolation for one owner, not a multi-tenant security boundary. Keep the host and browser updated.
- Exports remove proxy endpoints, proxy usernames and credential envelopes, detected IPs, pinned IPs and local account codes. User-supplied labels and notes remain and require review before sharing.

If GitHub private vulnerability reporting is enabled, use the repository's Security tab. Otherwise open an issue asking for a private reporting channel without posting exploit details, credentials or personal data. Do not send live Google cookies or proxy secrets.
