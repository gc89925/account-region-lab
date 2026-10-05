# Contributing

Thanks for helping improve Account Region Lab. Start with an issue describing a reproducible problem or a focused feature proposal. Small, tested pull requests are easiest to review.

## Development

```bash
npm ci --ignore-scripts
npm test
npm start
```

Use Node.js 24. Tests use temporary directories, mocked proxy responses and mocked browser sessions. Do not add tests requiring personal Google accounts, paid endpoints or public proxy availability. Real browser checks should use a fresh, disposable profile and the local diagnostics page.

## Useful contributions

- Better accessibility and translations.
- Browser compatibility reports using the local diagnostics page.
- Improvements to deterministic tests, profile lifecycle and export privacy.
- Well-sourced documentation about browser isolation and session management.
- Reproducible bug reports with tokens, emails, profile data and proxy credentials removed.

Keep claims narrower than the evidence. A country database match does not prove Google country association, a volunteer VPN is not verified residential service, and an opened security page is not confirmation that other sessions signed out. The project does not implement fake engagement, CAPTCHA bypass, fingerprint stealth, fabricated residence evidence, or automated Google appeals.

Please do not submit credentials or session data in issues, pull requests or screenshots. Stars are welcome if the project is useful; there is no exchange or incentive program for them.
