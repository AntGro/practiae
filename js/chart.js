// Tag distribution chart — port of the Flask app's vertical stacked bars
// (templates/partials/_routine_table.html): one column per day, total on
// top, segments stacked in tag order, tooltip on hover, and a
// Pieces/Duration toggle (by_count vs by_duration).
// `dayTotals` gives per-day { pieces, minutes }; segment heights come
// from the tag distribution. The total shown is pieces (count mode) or
// minutes (duration mode) — never the sum of tag occurrences, which
// double-counts pieces with two tags.
import { esc } from './utils.js';

export function tagChartHTML({ tagDistribution: td, columns, mode, dayTotals }) {
  const data = mode === 'duration' ? td.by_duration : td.by_count;
  let maxTotal = 0;
  for (let d = 0; d < columns.length; d++) {
    let t = 0;
    for (const tag of td.tags) t += (data[tag] && data[tag][d]) || 0;
    if (t > maxTotal) maxTotal = t;
  }
  if (maxTotal === 0) maxTotal = 1;
  const barMaxHeight = 160; // px, as in the Flask chart
  let html = '<div class="tag-dist-chart">';
  for (let d = 0; d < columns.length; d++) {
    const segs = [];
    for (const tag of td.tags) {
      const val = (data[tag] && data[tag][d]) || 0;
      if (val > 0) segs.push({ tag, val, color: td.tag_colors[tag] || '#17a2b8' });
    }
    const totalLabel = mode === 'duration'
      ? `${Math.round(dayTotals[d].minutes)} min`
      : `${dayTotals[d].pieces}`;
    const segsHtml = segs.map((seg) => {
      const h = (seg.val / maxTotal) * barMaxHeight;
      const tip = mode === 'duration'
        ? `${Math.round(seg.val)} min`
        : `${seg.val} piece${seg.val === 1 ? '' : 's'}`;
      return `<div class="tag-dist-segment" style="height:${h.toFixed(1)}px;background:${esc(seg.color)};"><span class="tag-dist-segment-tooltip">${esc(seg.tag)}: ${tip}</span></div>`;
    }).join('');
    html += `<div class="tag-dist-col"><span class="tag-dist-col-total">${totalLabel}</span><div class="tag-dist-bar-wrapper">${segsHtml}</div><span class="tag-dist-col-label">${esc(columns[d])}</span></div>`;
  }
  return html + '</div>';
}

export function tagChartLegendHTML(td) {
  return `<div class="legend">${td.tags.map((t) => `<span class="legend-item"><i style="background:${esc(td.tag_colors[t])}"></i>${esc(t)}</span>`).join('')}</div>`;
}
