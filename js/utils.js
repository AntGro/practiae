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

/**
 * Format a duration in minutes as m:ss (2.333… → "2:20"), as the Flask
 * app's routine table does — a raw float reads as a bug ("2.3333333333333335").
 * Seconds are truncated, as in the Flask template (total seconds | int).
 * Returns '' for a missing or zero duration, so the cell stays blank.
 */
export function formatDuration(min) {
  if (!min) return '';
  const total = Math.max(0, Math.floor(min * 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Inverse of formatDuration: parse what the duration edit box accepts.
 * "2:20" → 7/3 minutes; a plain number is minutes ("2.5" → 2.5), as the
 * edit box used to take; anything else (empty, text) → 0. Never negative.
 */
export function parseDuration(text) {
  const v = String(text ?? '').trim();
  if (!v) return 0;
  const m = v.match(/^(-?\d+):(\d+)$/);
  if (m) return Math.max(0, parseInt(m[1], 10) + parseInt(m[2], 10) / 60);
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/**
 * Frequency slider helpers — mirror the Flask app's routineForm.js.
 * Occurrences are k = round(perc * num_days / 100), so one day is worth
 * 100/num_days percent: the slider step must be that, not a fixed 5%,
 * or stops land between days (dead stops) and jumps are uneven.
 */
export function freqStep(numDays) {
  return 100 / Math.max(1, numDays);
}

/** Frequency percent -> whole days, same rounding as the generator's k. */
export function freqDays(perc, numDays) {
  return Math.round(((perc || 0) * Math.max(1, numDays)) / 100);
}

/**
 * Snap a stored percent to the day grid; 0 stays 0, anything else is at
 * least one day. Applied when the day count changes, like Flask's
 * updateSlider().
 */
export function snapPerc(perc, numDays) {
  if (!perc) return 0;
  const step = freqStep(numDays);
  return Math.max(step, Math.round(perc / step) * step);
}

/** Day-count label, e.g. "1 day", "4 days", "0 days". */
export function freqLabel(perc, numDays) {
  const d = freqDays(perc, numDays);
  return `${d} day${d === 1 ? '' : 's'}`;
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
