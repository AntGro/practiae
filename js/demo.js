// Demo entry boot: set the demo flag *before* the app loads, then load it.
// No sign-in, no Drive, no GIS script — data only in localStorage under
// the demo key (see adapters/local.js DEMO_KEY).
window.PRACTIAE_DEMO = true;
await import('./app.js');
