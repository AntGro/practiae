// Local adapter: localStorage. Works offline, no sign-in.
// Used as the default mode, as the fallback when Drive is unavailable,
// and (with its own key) as the demo adapter — demo data never touches
// the real local data or Drive.
const KEY = 'practiae-gdrive:v1';
export const DEMO_KEY = 'practiae-gdrive:demo:v1';

export function createLocalAdapter(storageKey = KEY) {
  return {
    kind: 'local',
    label: 'Local (this browser)',
    async load() {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    async save(doc) {
      localStorage.setItem(storageKey, JSON.stringify(doc));
    },
    async status() { return { ok: true, detail: 'Saved in this browser only' }; },
  };
}
export { KEY as LOCAL_STORAGE_KEY };
