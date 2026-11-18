// Shared helpers. No framework, no build step.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** One-click guard: disable the button until the promise settles. */
export async function guard(btn, fn) {
  if (!btn) return fn();
  if (btn.disabled) return;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function download(filename, text, mime = 'application/json') {
  // Chrome falls back to the name "download" for blob-URL downloads whose
  // download attribute contains non-ASCII characters — the default
  // program "Toutes les pièces" always exported as "download". Strip
  // diacritics and anything outside [A-Za-z0-9._-] first.
  const safe = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_');
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = safe; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
