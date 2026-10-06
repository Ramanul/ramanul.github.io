const WEB_MERCATOR_MAX_LAT = 85.0511287798066;

/** Validate the published geographic projection against the SVG's canonical viewBox. */
export function projectionForMap(metadata, viewBox) {
  const projection = metadata?.projection;
  const view = String(viewBox || "").trim().split(/\s+/).map(Number);
  if (metadata?.source_crs !== "EPSG:4326" || !projection || view.length !== 4) return null;

  const [vx, vy, viewWidth, viewHeight] = view;
  const values = [
    projection.lon_min, projection.lon_max, projection.lat_min, projection.lat_max,
    projection.width, projection.height, vx, vy, viewWidth, viewHeight,
  ];
  if (!values.every(Number.isFinite)
      || projection.method !== "equirectangular_cos_latitude_reference") return null;
  if (projection.lon_max <= projection.lon_min || projection.lat_max <= projection.lat_min
      || projection.width <= 0 || projection.height <= 0) return null;
  if (Math.abs(vx) > 0.02 || Math.abs(vy) > 0.02
      || Math.abs(viewWidth - projection.width) > 0.02
      || Math.abs(viewHeight - projection.height) > 0.02) return null;
  if (projection.lat_min <= -WEB_MERCATOR_MAX_LAT || projection.lat_max >= WEB_MERCATOR_MAX_LAT) return null;

  return { ...projection, vx, vy, viewWidth, viewHeight };
}

/**
 * Return a MapLibre camera matching an SVG viewBox window.
 * The SVG projection is linear in latitude; a small local Y correction compensates for
 * Web Mercator's sec(latitude) scale. The thematic geometry remains authoritative.
 */
export function cameraForView(view, projection, viewportWidth) {
  if (!view || !projection || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return null;
  const numbers = [view.x, view.y, view.width, view.height];
  if (!numbers.every(Number.isFinite) || view.width <= 0 || view.height <= 0) return null;

  const lonRange = projection.lon_max - projection.lon_min;
  const latRange = projection.lat_max - projection.lat_min;
  if (!Number.isFinite(lonRange) || !Number.isFinite(latRange) || lonRange <= 0 || latRange <= 0) return null;

  const xRatio = (view.x + view.width / 2 - projection.vx) / projection.viewWidth;
  const yRatio = (view.y + view.height / 2 - projection.vy) / projection.viewHeight;
  const centerLon = projection.lon_min + xRatio * lonRange;
  const centerLat = projection.lat_max - yRatio * latRange;
  const lonSpan = view.width / projection.viewWidth * lonRange;
  if (![centerLon, centerLat, lonSpan].every(Number.isFinite) || lonSpan <= 0
      || Math.abs(centerLat) >= WEB_MERCATOR_MAX_LAT) return null;

  const zoom = Math.max(2, Math.min(19,
    Math.log2(viewportWidth * 360 / (512 * lonSpan))));
  const localYPerX = (projection.height / latRange) / (projection.width / lonRange);
  const scaleY = Math.max(0.85, Math.min(1.15,
    localYPerX * Math.cos(centerLat * Math.PI / 180)));
  if (![zoom, scaleY].every(Number.isFinite)) return null;

  return { center: [centerLon, centerLat], zoom, scaleY };
}
