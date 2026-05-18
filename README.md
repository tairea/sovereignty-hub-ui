# hub-ui

Sovereignty Hub web app: 13-Pillars survey, 3D hub visualization, globe-network view, Supabase-backed hub directory.

Migrated from the standalone `sovereignty-survey.html` in `../sovereignty-hub`.

## Stack

- **Vite** — dev server + build
- **Three.js** — survey visualization
- **globe.gl** — global hub-network view (Phase 2)
- **@supabase/supabase-js** — auth + hub directory (Phase 3)
- **Font Awesome** (via CDN in `index.html`) — pillar icons

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/
```

## Environment

Copy `.env.sample` to `.env` and fill the Supabase keys (already filled in this repo). Vite exposes any `VITE_*` env var to the client at build time.

## Layout

```
hub-ui/
├── index.html        # entry document (head + body shell)
├── src/
│   ├── main.js       # bootstrap + everything wired together
│   ├── style.css     # all styles
│   └── lib/
│       └── geocode.js  # Nominatim address → {lat, lng}
└── vite.config.js
```

## Roadmap

- [x] Phase 0 — Vite scaffold + monolithic file split
- [ ] Phase 1 — Location capture via typed address (Nominatim)
- [ ] Phase 2 — Globe view (graph ↔ globe toggle)
- [ ] Phase 3 — Supabase auth (magic link) + sync
- [ ] Phase 4 — Multi-hub discovery on the globe
