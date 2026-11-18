# Third-Party Attributions

Practiae is a static front-only app with no runtime npm dependencies.
It uses the same third-party sources as DeLaClaw (Antoine's life OS,
same architecture), listed below.

## Fonts

### DM Sans
- **License**: SIL Open Font License 1.1
- **Source**: https://fonts.google.com/specimen/DM+Sans
- **Designers**: Colophon Foundry, Jonny Pinhorn, Indian Type Foundry
- **Loaded from**: `fonts.googleapis.com` / `fonts.gstatic.com` (same as DeLaClaw)
- **Purpose**: primary typeface throughout the app and the welcome page

## Icons

### Lucide
- **License**: ISC
- **Source**: https://github.com/lucide-icons/lucide
- **Purpose**: all UI icons throughout the app and the welcome page
- **Note**: icon SVG path data is embedded directly in `js/icons.js`
  (copied from DeLaClaw's `js/icons.js`, same subset approach — not
  loaded from CDN). Only the icons Practiae uses are included.

## Google

### Google Identity Services
- **Library**: GIS (`accounts.google.com/gsi/client`)
- **License**: Google APIs Terms of Service
- **Source**: https://developers.google.com/identity
- **Loaded from**: `accounts.google.com/gsi/client` (must stay on CDN per
  Google ToS, documented CSP exception — same as DeLaClaw)
- **Purpose**: OAuth 2.0 token flow for the Google Drive backend mode

### Google API Client (GAPI)
- **Library**: `apis.google.com/js/api.js`
- **License**: Google APIs Terms of Service
- **Source**: https://developers.google.com/api-client-library/javascript
- **Loaded from**: `apis.google.com` (CDN, loaded on demand for Drive mode)
- **Purpose**: Google Drive API file operations (one `practiae.json` file)

## Logo

The Practiae logo (`js/logo.js`) is original work: five concentric
practice ripples with a solid dot for today, generated as a single SVG
in JS and theme-aware via `currentColor`. The approach — a generated,
theme-aware SVG logo — is inspired by DeLaClaw's Storm logo
(`js/logo.js` in DeLaClaw), but the mark itself is new.

## Development only

### Playwright
- **License**: Apache-2.0
- **Source**: https://github.com/microsoft/playwright
- **Purpose**: headless-browser smoke tests (`tests/browser-smoke.mjs`,
  `tests/shots.mjs`) — not shipped to users, not loaded by the app.
