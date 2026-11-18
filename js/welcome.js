// Welcome page: logo + a live preview of what Practiae generates.
// The preview is real, not a mock: it loads the same seed program the
// demo ships with (data/default_routine.json), runs the same generator
// the app uses, and renders the same stacked-bar tag chart as the app.
// If the seed can't load (e.g. opened as a file), the preview hides
// and the two choice cards still work.
import { generatePractiaeLogo } from './logo.js';
import { lucideIcon } from './icons.js';
import { seedFromDefault, currentProgram, generationPieces } from './store.js';
import { generateRoutine } from './generate.js';
import { esc } from './utils.js';

const $ = (s) => document.querySelector(s);

$('#logo').innerHTML = generatePractiaeLogo({ size: 120 });
// Inline Lucide icons (same embedded subset as the app — no CDN, no emoji).
document.querySelectorAll('[data-icon]').forEach((el) => {
  el.innerHTML = lucideIcon(el.dataset.icon, +(el.dataset.size || 22));
});

try {
  const res = await fetch('data/default_routine.json');
  if (!res.ok) throw new Error('seed not found');
  const doc = seedFromDefault(await res.json());
  const p = currentProgram(doc);
  const gen = generateRoutine({ num_days: p.num_days, pieces: generationPieces(p) }, [], []);

  const perDay = gen.days.reduce((s, d) => s + d.length, 0) / p.num_days;
  const stats = [
    { icon: 'music', value: p.pieces.length, label: 'pieces in the demo program', color: '#5a178a' },
    { icon: 'repeat', value: p.num_days, label: 'days per cycle', color: '#ec4899' },
    { icon: 'bar-chart-3', value: Math.round(perDay), label: 'pieces a day, on average', color: '#06b6d4' },
    { icon: 'database', value: 1, label: 'file in your Google Drive', color: '#6366f1' },
  ];
  $('#welcome-stats').innerHTML = stats.map((s) => `
    <div class="welcome-stat-card" style="--stat-color:${s.color}">
      <div class="welcome-stat-top">
        <span class="welcome-stat-icon">${lucideIcon(s.icon, 22, s.color)}</span>
        <span class="welcome-stat-value">${s.value}</span>
      </div>
      <div class="welcome-stat-label">${esc(s.label)}</div>
    </div>`).join('');

  // Tag distribution chart — same stacked bars as the app's own chart.
  const td = gen.tagDistribution;
  if (td?.tags?.length) {
    $('#welcome-chart').innerHTML = `<h3>What a generated week looks like</h3>
      <p class="muted small">Tag mix per day, from the demo program — generated live just now.</p>
      <div class="chart">${td.by_count[td.tags[0]].map((_, d) => {
        // Bar widths are shares of tag occurrences (a piece with two tags
        // counts twice); the total shown is pieces that day, not the sum
        // of occurrences — otherwise a 68-piece day reads "136".
        const segTotal = td.tags.reduce((s, t) => s + td.by_count[t][d], 0) || 1;
        const piecesToday = gen.days[d].length;
        const segs = td.tags.map((t) => {
          const n = td.by_count[t][d];
          return n ? `<div class="chart-seg" style="width:${(n / segTotal * 100).toFixed(1)}%;background:${esc(td.tag_colors[t])}" title="${esc(t)}: ${n}"></div>` : '';
        }).join('');
        return `<div class="chart-row"><span class="chart-day">${esc(p.day_names[d] || `Day ${d + 1}`)}</span><div class="chart-bar">${segs}</div><span class="chart-total" title="${segTotal} tag occurrences">${piecesToday}</span></div>`;
      }).join('')}</div>
      <div class="legend">${td.tags.map((t) => `<span class="legend-item"><i style="background:${esc(td.tag_colors[t])}"></i>${esc(t)}</span>`).join('')}</div>`;
  }
} catch {
  $('#welcome-preview').hidden = true;
}
