// Google Drive adapter — single-file, front-only, like DeLaClaw's drive
// adapter but simplified: Practiae's whole document is ONE file,
// `practiae.json`, in a `Practiae/` (prod) or `PractiaeDev/` (localhost)
// folder. No server, no client secret: Google Identity Services token
// client, `drive.file` scope only (the app can only see files it created).
//
// Flow: find-or-create folder -> find-or-create practiae.json -> download
// on boot -> debounced upload (2s) on every mutation -> poll every 30s
// for remote changes (md5). Before overwriting, re-read the file's md5:
// if it changed since our last read/write and we did not write it, refuse
// and report a conflict instead of silently overwriting another tab.
// (DeLaClaw learned ETags are not returned in practice for Drive files,
// so md5 is the pre-check here, as in its extension data contracts.)
//
// Token: in-memory + sessionStorage (survives refresh within its ~1h
// lifetime), never in the data file, never in localStorage.

import { DRIVE_SCOPE, DATA_FILE_NAME, driveFolderName } from '../config.js';

const TOKEN_KEY = 'practiae_drive_token';
const DEBOUNCE_MS = 2000;
const POLL_MS = 30000;

let cachedToken = null;
let tokenExpiry = 0;
let pendingToken = null;

function loadPersistedToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { token, expiry } = JSON.parse(raw);
    if (token && expiry && Date.now() < expiry - 60000) return { token, expiry };
  } catch {}
  return null;
}
function persistToken(token, expiry) {
  try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiry })); } catch {}
}
export function clearDriveToken() {
  cachedToken = null; tokenExpiry = 0; pendingToken = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google Identity Services — check network / content blocker'));
    document.head.appendChild(s);
  });
}

export async function getDriveToken(clientId, prompt = true) {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const persisted = loadPersistedToken();
  if (persisted) { cachedToken = persisted.token; tokenExpiry = persisted.expiry; return cachedToken; }
  if (pendingToken) return pendingToken;
  await loadGis();
  pendingToken = new Promise((resolve, reject) => {
    let settled = false;
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      prompt: prompt ? 'consent' : '',
      callback: (resp) => {
        settled = true; pendingToken = null;
        if (resp.error) { reject(new Error(`Google sign-in failed: ${resp.error}`)); return; }
        cachedToken = resp.access_token;
        tokenExpiry = Date.now() + (+resp.expires_in || 3600) * 1000;
        persistToken(cachedToken, tokenExpiry);
        resolve(cachedToken);
      },
      error_callback: (err) => {
        if (settled) return;
        settled = true; pendingToken = null;
        reject(new Error(`Google sign-in failed: ${err?.type || 'unknown error'}. If this mentions origin, add this origin as an authorised JavaScript origin on the OAuth client.`));
      },
    });
    client.requestAccessToken();
  });
  return pendingToken;
}

async function driveFetch(token, url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (res.status === 401) { clearDriveToken(); throw new Error('Google token expired — sign in again'); }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`Drive request failed (${res.status}) ${detail}`.trim());
  }
  return res;
}

async function findOrCreateFolder(token, name) {
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const list = await (await driveFetch(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`)).json();
  if (list.files?.length) return list.files[0].id;
  const created = await (await driveFetch(token, 'https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  })).json();
  return created.id;
}

async function fileMeta(token, folderId) {
  const q = encodeURIComponent(`name='${DATA_FILE_NAME}' and '${folderId}' in parents and trashed=false`);
  const list = await (await driveFetch(token,
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,md5Checksum,modifiedTime)`)).json();
  return list.files?.[0] || null;
}

export function createDriveAdapter(clientId, onStatus, onRemoteChange) {
  let folderId = null;
  let fileId = null;
  let lastMd5 = null;
  let saveTimer = null;
  let pollTimer = null;
  let pendingDoc = null;
  let destroyed = false;

  async function ensureFile(token) {
    if (!folderId) folderId = await findOrCreateFolder(token, driveFolderName());
    if (!fileId) {
      const meta = await fileMeta(token, folderId);
      if (meta) { fileId = meta.id; lastMd5 = meta.md5Checksum || null; }
    }
    return fileId;
  }

  async function upload(token, doc) {
    const body = JSON.stringify(doc, null, 2);
    if (!fileId) {
      const metadata = { name: DATA_FILE_NAME, mimeType: 'application/json', parents: [folderId] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', new Blob([body], { type: 'application/json' }));
      const created = await (await driveFetch(token,
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        { method: 'POST', body: form })).json();
      fileId = created.id; lastMd5 = created.md5Checksum || null;
      return;
    }
    // md5 pre-check: refuse to overwrite a remote change we have not seen.
    const meta = await fileMeta(token, folderId);
    if (meta && lastMd5 && meta.md5Checksum && meta.md5Checksum !== lastMd5 && meta.id === fileId) {
      throw new Error('Conflict: practiae.json changed in Drive (another tab/device?) since it was last read. Reload to see the remote version before saving.');
    }
    const updated = await (await driveFetch(token,
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })).json();
    lastMd5 = updated.md5Checksum || meta?.md5Checksum || lastMd5;
  }

  function scheduleSave(doc) {
    pendingDoc = doc;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (destroyed || !pendingDoc) return;
      const docToSave = pendingDoc; pendingDoc = null;
      try {
        onStatus?.({ state: 'saving' });
        const token = await getDriveToken(clientId, true);
        await ensureFile(token);
        await upload(token, docToSave);
        onStatus?.({ state: 'saved', detail: 'Saved to Google Drive' });
      } catch (err) {
        pendingDoc = docToSave;
        onStatus?.({ state: 'error', detail: String(err.message || err) });
      }
    }, DEBOUNCE_MS);
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (destroyed || !fileId || pendingDoc) return;
      try {
        const token = await getDriveToken(clientId, false);
        const meta = await fileMeta(token, folderId);
        if (meta && lastMd5 && meta.md5Checksum && meta.md5Checksum !== lastMd5) {
          lastMd5 = meta.md5Checksum;
          const res = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
          onRemoteChange?.(await res.json());
        }
      } catch { /* poll failures are silent; next poll retries */ }
    }, POLL_MS);
  }

  return {
    kind: 'drive',
    label: 'Google Drive',
    async load() {
      const token = await getDriveToken(clientId, true);
      await ensureFile(token);
      if (!fileId) return null;
      const res = await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      const doc = await res.json();
      startPolling();
      return doc;
    },
    async save(doc) { scheduleSave(doc); },
    async flush(doc) {
      clearTimeout(saveTimer);
      pendingDoc = null;
      const token = await getDriveToken(clientId, true);
      await ensureFile(token);
      await upload(token, doc);
    },
    async status() { return { ok: !!cachedToken, detail: fileId ? `Drive file practiae.json (${driveFolderName()}/)` : 'Drive connected, no file yet' }; },
    destroy() { destroyed = true; clearTimeout(saveTimer); clearInterval(pollTimer); },
  };
}
