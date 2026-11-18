// Welcome page: a live preview of what Practiae generates.
// The preview is real, not a mock: it loads the same seed program the
// demo ships with (data/default_routine.json), runs the same generator
// the app uses, and renders the same tag chart as the app (vertical
// stacked bars, Pieces/Duration toggle — ported from the Flask app).
// If the seed can't load (e.g. opened as a file), the preview hides
// and the two choice cards still work. The logo is the original
// Practiae favicon, inlined in index.html as an <img>.
import { lucideIcon } from './icons.js';
import { seedFromDefault, currentProgram, generationPieces } from './store.js';
import { generateRoutine } from './generate.js';
import { tagChartHTML, tagChartLegendHTML } from './chart.js';
import { esc } from './utils.js';

const $ = (s) => document.querySelector(s);

// Inline Lucide icons (same embedded subset as the app — no CDN, no emoji).
document.querySelectorAll('[data-icon]').forEach((el) => {
  el.innerHTML = lucideIcon(el.dataset.icon, +(el.dataset.size || 22));
});

let preview = null; // { tagDistribution, columns, dayTotals }
let previewMode = 'count';
function renderWelcomeChart() {
  if (!preview) return;
  $('#welcome-chart').innerHTML = `<h3>What a generated week looks like</h3>
    <p class="muted small">Tag mix per day, from the demo program — generated live just now.</p>
    <label class="chart-mode"><span>Pieces</span><input type="checkbox" id="tag-dist-mode-welcome" ${previewMode === 'duration' ? 'checked' : ''} aria-label="Show durations instead of piece counts"><span>Duration</span></label>
    ${tagChartHTML({ tagDistribution: preview.tagDistribution, columns: preview.columns, mode: previewMode, dayTotals: preview.dayTotals })}
    ${tagChartLegendHTML(preview.tagDistribution)}`;
}
document.addEventListener('change', (e) => {
  if (e.target.id === 'tag-dist-mode-welcome') {
    previewMode = e.target.checked ? 'duration' : 'count';
    renderWelcomeChart();
  }
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

  // Tag distribution chart — the same vertical bars as the app.
  const td = gen.tagDistribution;
  if (td?.tags?.length) {
    preview = {
      tagDistribution: td,
      columns: p.day_names,
      dayTotals: gen.days.map((day) => ({
        pieces: day.length,
        minutes: day.reduce((s, pc) => s + (pc.duration_min || 0), 0),
      })),
    };
    renderWelcomeChart();
  }
} catch {
  $('#welcome-preview').hidden = true;
}
