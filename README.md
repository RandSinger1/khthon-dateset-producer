# Khthon Grave Shapefile Builder

A web UI for digitizing grave boundaries on a satellite map by clicking
vertices, tracking how a grave's outline changes over time via a date
timeline, and exporting real Esri shapefiles per date.

This is a fully static, client-side app (HTML/CSS/JS, no backend, no build
step) so it can be hosted directly on GitHub Pages.

## Features

- Satellite basemap (Esri World Imagery), click to place polygon vertices.
- Right-click a vertex to delete it; undo/clear controls for the active date.
- Timeline: add any number of dates per item, each with its own polygon.
  Switching dates swaps the satellite basemap to imagery from that time
  (via [Esri World Imagery Wayback](https://livingatlas.arcgis.com/wayback/),
  snapped to the nearest available historical capture) and shows only that
  date's polygon — but **the map's pan/zoom never changes**, so you stay
  oriented as you move through time. The sidebar always shows which actual
  capture date you're looking at.
- Coordinate search box ("lat, lng") to jump straight to a location.
- On submit, you're asked whether the grave is **clandestine** or
  **attached to a cemetery** — this is saved into each shapefile's
  attribute table and into a `metadata.json` bundled alongside it.
- Submitting generates real `.shp`/`.shx`/`.dbf`/`.prj` files (WGS84,
  EPSG:4326) in the browser via `@mapbox/shp-write`, one shapefile per
  date, zipped together with `JSZip` and downloaded straight to your
  machine — no server involved.
- The sidebar remembers previously submitted items on this device
  (`localStorage`) as a quick reference; the underlying data lives in each
  downloaded zip, not on any server.

## Run locally

No build step or dependencies to install — it's plain static files. Any
static file server works, e.g.:

```
python -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` directly via
`file://` also mostly works, but some browsers restrict `fetch`/module
behavior on `file://`, so a local server is recommended.)

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment", set **Source** to "Deploy from a branch".
4. Pick the branch (e.g. `main`) and folder **/ (root)**, then save.
5. GitHub will publish the site at `https://<username>.github.io/<repo>/`
   within a minute or two.

No further configuration is needed — `index.html` is at the repo root and
all asset paths are relative, so it works whether the site is served at a
domain root or under a `/<repo>/` subpath.

## Output

Each submission downloads a zip named `<item-slug>_<timestamp>.zip`
containing:

- `<date>.shp` / `.shx` / `.dbf` / `.prj` — one shapefile per date, WGS84
  (EPSG:4326), attributes: `item`, `date`, `grave_type`, `created_at`,
  `img_date` (the actual Wayback capture date the polygon was drawn against).
- `metadata.json` — item name, grave type, creation time, and each date
  paired with its matched imagery capture date.

## Historical imagery notes

- Esri's Wayback archive has irregular coverage — captures are roughly
  every few weeks to months since ~2014, and resolution/availability
  varies a lot by region. The nearest available capture is used, and the
  actual date is always shown, but it may be well off from the date you
  picked in sparsely-covered areas.
- The release list is fetched live from Esri's config endpoint on page
  load. If that fetch fails (offline, endpoint unreachable), the app falls
  back to a single current-imagery layer and a status message says
  historical dates won't change the basemap — everything else still works.
