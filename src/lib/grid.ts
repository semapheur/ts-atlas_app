import { geoStream, type GeoProjection } from "d3-geo";

export type GridMode = "graticule" | "utm";

export interface GridBuffers {
  graticule: Float32Array;
  utm: Float32Array;
  special: Float32Array; // equator, tropics, polar circles
}

type XY = [number, number];

// Shared with the renderer's glyph atlas
export const GLYPHS = "0123456789CDEFGHJKLMNPQRSTUVWX";
export const GLYPH_ADV = 8; // CSS px per character
export const GLYPH_H = 12;

const STEP = 1; // degrees between samples
const BANDS = "CDEFGHJKLMNPQRSTUVWX";
const TROPIC = 23.4366;
const POLAR = 66.5634;

const ramp = (a: number, b: number): number[] => {
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / STEP));
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
};
const parallel = (lat: number, lon0 = -180, lon1 = 180): XY[] =>
  ramp(lon0, lon1).map((lon) => [lon, lat]);
const meridian = (lon: number, lat0: number, lat1: number): XY[] =>
  ramp(lat0, lat1).map((lat) => [lon, lat]);

// ── static geometry (built once) ─────────────────────────────────────

const GRATICULE: XY[][] = [];
for (let lon = -180; lon <= 180; lon += 10) {
  const lim = lon % 90 === 0 ? 90 : 80;
  GRATICULE.push(meridian(lon, -lim, lim));
}
for (let lat = -80; lat <= 80; lat += 10) GRATICULE.push(parallel(lat));

const SPECIAL: XY[][] = [0, TROPIC, -TROPIC, POLAR, -POLAR].map((l) =>
  parallel(l),
);

interface UtmCell {
  zone: number;
  band: string;
  lon: number; // center
  lat: number;
  dLon: number;
  dLat: number;
}

const bandLat = (i: number): [number, number] => {
  const s = -80 + 8 * i;
  return [s, i === BANDS.length - 1 ? 84 : s + 8];
};

function zoneEdges(band: string): number[] {
  const edges: number[] = [];
  for (let l = -180; l <= 180; l += 6) edges.push(l);
  // Norway: 32V is widened to 3°E–12°E
  if (band === "V")
    return [...edges.filter((l) => l !== 6), 3].sort((a, b) => a - b);
  // Svalbard: only 31X, 33X, 35X, 37X exist
  if (band === "X")
    return [...edges.filter((l) => l <= 0 || l >= 42), 9, 21, 33].sort(
      (a, b) => a - b,
    );
  return edges;
}

const UTM_CELLS: UtmCell[] = [];
const UTM: XY[][] = [];

for (let i = 0; i < BANDS.length; i++) {
  const [lat0, lat1] = bandLat(i);
  const edges = zoneEdges(BANDS[i]);
  for (const e of edges) UTM.push(meridian(e, lat0, lat1));
  for (let k = 0; k < edges.length - 1; k++) {
    const lon = (edges[k] + edges[k + 1]) / 2;
    UTM_CELLS.push({
      zone: Math.floor((lon + 180) / 6) + 1,
      band: BANDS[i],
      lon,
      lat: (lat0 + lat1) / 2,
      dLon: edges[k + 1] - edges[k],
      dLat: lat1 - lat0,
    });
  }
}
for (let i = 0; i <= BANDS.length; i++) {
  UTM.push(parallel(i === BANDS.length ? 84 : -80 + 8 * i));
}

// ── projection ───────────────────────────────────────────────────────

/** Projects lines through the projection's stream (clipping + resampling)
 *  into a flat [x0, y0, x1, y1, ...] segment list for gl.LINES. */
function project(projection: GeoProjection, lines: XY[][]): Float32Array {
  const out: number[] = [];
  let prev: XY | null = null;

  const sink = {
    point(x: number, y: number) {
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (prev) out.push(prev[0], prev[1], x, y);
        prev = [x, y];
      } else {
        prev = null;
      }
    },
    lineStart() {
      prev = null;
    },
    lineEnd() {
      prev = null;
    },
    polygonStart() {},
    polygonEnd() {},
    sphere() {},
  };

  geoStream(
    { type: "MultiLineString", coordinates: lines },
    projection.stream(sink),
  );
  return new Float32Array(out);
}

export function buildGridBuffers(
  projection: GeoProjection,
  mode: GridMode,
): GridBuffers {
  const empty = new Float32Array(0);
  return {
    graticule: mode === "graticule" ? project(projection, GRATICULE) : empty,
    utm: mode === "utm" ? project(projection, UTM) : empty,
    special: project(projection, SPECIAL),
  };
}

// ── UTM labels ───────────────────────────────────────────────────────

export interface LabelContext {
  width: number;
  height: number;
  zoom: number;
  pan: XY;
}

/** Glyph instances: [x, y (projected px), xOffset (CSS px), glyphIndex] */
export function buildUtmLabels(
  p: GeoProjection,
  ctx: LabelContext,
): Float32Array {
  const out: number[] = [];
  const jumpLimit = 0.35 * Math.min(ctx.width, ctx.height);

  const proj = (pt: XY): XY | null => {
    const q = p(pt);
    return q && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null;
  };

  // On-screen distance in px; 0 if unprojectable or the span crosses a seam
  const dist = (a: XY, b: XY): number => {
    const pa = proj(a);
    const pb = proj(b);
    if (!pa || !pb) return 0;
    const d = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    return d > jumpLimit ? 0 : d * ctx.zoom;
  };

  const push = (q: XY, text: string) => {
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const g = GLYPHS.indexOf(text[i]);
      if (g >= 0) out.push(q[0], q[1], (i - (n - 1) / 2) * GLYPH_ADV, g);
    }
  };

  // 1. Full designators wherever the cell is big enough
  let full = 0;
  for (const c of UTM_CELLS) {
    const w = dist([c.lon - c.dLon / 2, c.lat], [c.lon + c.dLon / 2, c.lat]);
    const h = dist([c.lon, c.lat - c.dLat / 2], [c.lon, c.lat + c.dLat / 2]);
    if (w < 3 * GLYPH_ADV + 6 || h < GLYPH_H + 6) continue;
    const q = proj([c.lon, c.lat]);
    if (!q) continue;
    push(q, `${c.zone}${c.band}`);
    full++;
  }
  if (full > 0) return new Float32Array(out);

  // 2. Zoomed out: zone numbers and band letters through the view center
  let alon = 0;
  let alat = 0;
  if (p.invert) {
    const x = ctx.width / 2 - ctx.pan[0] / ctx.zoom;
    const y = ctx.height / 2 - ctx.pan[1] / ctx.zoom;
    const g = p.invert([x, y]);
    const back =
      g && Number.isFinite(g[0]) && Number.isFinite(g[1]) ? p(g) : null;
    if (g && back && Math.hypot(back[0] - x, back[1] - y) < 1) {
      [alon, alat] = g;
    }
  }

  const lat = Math.max(-79, Math.min(83, alat));
  const zoneWidth = dist([alon - 3, lat], [alon + 3, lat]);
  const stride =
    zoneWidth > 0
      ? ([1, 2, 5, 10].find((s) => s * zoneWidth >= 2 * GLYPH_ADV + 8) ?? 10)
      : 5;

  for (let z = 1; z <= 60; z++) {
    if (stride > 1 && z !== 1 && z % stride !== 0) continue;
    const lon = -180 + 6 * z - 3;
    if (Math.abs(lon - alon) <= 3) continue; // keep clear of the band letter
    const q = proj([lon, lat]);
    if (q) push(q, String(z));
  }

  for (let i = 0; i < BANDS.length; i++) {
    const [a, b] = bandLat(i);
    if (dist([alon, a], [alon, b]) < GLYPH_H + 4) continue;
    const q = proj([alon, (a + b) / 2]);
    if (q) push(q, BANDS[i]);
  }

  return new Float32Array(out);
}
