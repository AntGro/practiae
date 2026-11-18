// ===================================================================
// Practiae logo — generated SVG, same approach as DeLaClaw's Storm
// logo (js/logo.js there): one SVG, generated in JS, theme-aware via
// currentColor with varying opacity, no image file, no emoji.
// The mark is original: five concentric practice ripples — a routine
// built up day after day — with a solid dot for today.
// ===================================================================

export const LOGO_DEFAULTS = {
  arcs: 5,            // number of ripples
  strokeWidth: 9,
  size: 120,          // viewBox dimension
};

/**
 * Generate the Practiae logo SVG as a string (inner markup + wrapper).
 * @param {object} params — merged with LOGO_DEFAULTS
 * @returns {string} a complete <svg> element
 */
export function generatePractiaeLogo(params = {}) {
  const p = { ...LOGO_DEFAULTS, ...params };
  const size = p.size;
  const cx = size / 2, cy = size / 2;
  const maxR = size * 0.44;
  const step = maxR / p.arcs;
  let arcs = '';
  for (let i = 0; i < p.arcs; i++) {
    const r = maxR - i * step;
    // Opacity fades outward-in like the Storm gradient: the newest
    // ripple (innermost) is the strongest.
    const opacity = (0.25 + 0.75 * (1 - i / p.arcs)).toFixed(2);
    arcs += `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="currentColor" stroke-opacity="${opacity}" stroke-width="${p.strokeWidth}"/>`;
  }
  // Today: the solid dot at the centre.
  const dotR = Math.max(4, step * 0.32);
  arcs += `<circle cx="${cx}" cy="${cy}" r="${dotR.toFixed(1)}" fill="currentColor"/>`;
  return `<svg class="practiae-logo" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Practiae logo">${arcs}</svg>`;
}
