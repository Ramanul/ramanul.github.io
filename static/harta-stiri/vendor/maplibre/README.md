# Vendored MapLibre GL JS

- Version: `maplibre-gl@6.12.0` (npm distribution, BSD-3-Clause).
- Upstream: https://github.com/maplibre/maplibre-gl-js
- Only the browser distribution files used by the map are kept here: module, shared module, worker module, and CSS.
- Upstream license text: `LICENSE.txt`.

The map imports this local copy so the site's same-origin `script-src` policy stays closed to third-party JavaScript. Vector style/tiles are fetched at runtime from OpenFreeMap, separately covered by the map page's visible attribution and the narrow CSP origins.
