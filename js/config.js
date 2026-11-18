// Configuration. The Google client id is public (not a secret) — it only
// identifies the OAuth app. The Drive token itself lives in sessionStorage
// and is never written to disk or to the stored practiae.json.
//
// Default is DeLaClaw's OAuth client (same Google Cloud project Antoine
// already uses for DeLaClaw Drive access). It works here only if the
// current origin is an authorised JavaScript origin on that client.
// Localhost usually is; practiae.com and antgro.github.io are not yet —
// if Google answers `redirect_uri_mismatch` / `origin_mismatch`, add the
// origin in Google Cloud Console (or create a Web OAuth client for
// Practiae with the drive.file scope) and paste its id in Settings, or
// pass ?client_id=... — it is stored in localStorage, not in the data file.
export const DEFAULT_CLIENT_ID = '883846698493-5v6hfn0vvnq7mn5gua454cgvibbgqt8i.apps.googleusercontent.com';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DATA_FILE_NAME = 'practiae.json';
export const SCHEMA_VERSION = 1;

export function currentHostname() {
  return typeof location === 'undefined' ? '' : location.hostname;
}
export function isProdHostname(hostname) {
  return ['practiae.com', 'www.practiae.com', 'antgro.github.io'].includes(String(hostname || '').toLowerCase());
}
/** `Practiae/` in production, `PractiaeDev/` everywhere else (localhost, previews). */
export function driveFolderName(hostname = currentHostname()) {
  return isProdHostname(hostname) ? 'Practiae' : 'PractiaeDev';
}

export function resolveClientId() {
  try {
    const q = new URLSearchParams(location.search).get('client_id');
    if (q) { localStorage.setItem('practiae:client_id', q); return q; }
    return localStorage.getItem('practiae:client_id') || DEFAULT_CLIENT_ID;
  } catch { return DEFAULT_CLIENT_ID; }
}
export function saveClientId(id) {
  try { localStorage.setItem('practiae:client_id', id); } catch {}
}
