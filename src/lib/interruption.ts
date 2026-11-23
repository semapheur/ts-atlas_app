import {
  geoAzimuthalEquidistantRaw,
  geoRotation,
  geoStream,
  type GeoProjection,
  type GeoStream,
} from "d3-geo";
import { geoClipPolygon } from "d3-geo-polygon";
import { geoStitch } from "d3-geo-projection";

/**
 * d3-geo-projection's interrupted projections don't clip: they only decide,
 * per point, which lobe it lands in. Any edge that crosses a cut is therefore
 * drawn straight across the void. This module clips on the sphere instead.
 *
 * Each kind describes its "cells" in the projection's rotated frame (the frame
 * d3's preclip runs in): a cell is a region that the projection maps
 * continuously. Geometry that touches a single cell is streamed as-is, which is
 * cheap. Only geometry that spans several cells is clipped, once per cell it
 * touches.
 */
export type InterruptionKind =
  | "lobes" //    geoInterrupted*: northern/southern lobe tables
  | "healpix" //  H longitude wedges
  | "gingery" //  n azimuthal sectors around the center
  | "berghaus" // front hemisphere + n back-hemisphere sectors
  | "armadillo" // only the part of the sphere on the "shell" is drawn
  | "littrow"; //   unbounded plane: only a finite latitude band is drawn

/** Latitude limit of the Littrow band; the projection's fit object must match. */
export const LITTROW_LAT = 70;

export interface StreamTarget {
  sink: GeoStream;
  /** Stream polygons as their rings (lines), so cuts add no closing edges. */
  asLines?: boolean;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const EPS = 1e-4; // degrees: keeps boundary vertices inside their own cell
const EPS_RAD = 1e-4;

type Ring = number[][];

interface CellScheme {
  rings: Ring[]; // one clip ring per cell (clockwise seen from outside)
  /** Cell of a point in the rotated frame, or -1 if it is not drawn. */
  cellOf(lon: number, lat: number): number;
  clips: unknown[]; // lazily built geoClipPolygon per cell
}

type Mutable = {
  lobes?: () => unknown;
  parallel?: () => number;
  preclip(): unknown;
  preclip(f: unknown): unknown;
};

const mod = (a: number, n: number) => ((a % n) + n) % n;

function densify(corners: number[][], step = 5): Ring {
  const ring: Ring = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1];
    const b = corners[i];
    const n = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / step),
    );
    for (let k = 1; k <= n; k++) {
      ring.push([
        a[0] + ((b[0] - a[0]) * k) / n,
        a[1] + ((b[1] - a[1]) * k) / n,
      ]);
    }
  }
  return ring;
}

/** Point at angular distance s and bearing th from the rotated-frame center (0,0). */
function fromCenter(s: number, th: number): number[] {
  const x = Math.cos(s);
  const y = Math.sin(s) * Math.cos(th); // east
  const z = Math.sin(s) * Math.sin(th); // north
  return [Math.atan2(y, x) * DEG, Math.asin(z) * DEG];
}

/** Bearing from the center, same convention as d3's azimuthal equidistant. */
function bearing(lon: number, lat: number): number {
  const [x, y] = geoAzimuthalEquidistantRaw(lon * RAD, lat * RAD);
  return Math.atan2(y, x);
}

/** Rings built counter-clockwise are reversed: d3 wants clockwise exteriors. */
const cw = (ring: Ring) => ring.reverse();

/** Sector between bearings t0 < t1, for distances s0..s1 from the center. */
function sectorRing(t0: number, t1: number, s0: number, s1: number): Ring {
  const ring: Ring = [];
  const N = 36;
  for (let m = 0; m <= N; m++)
    ring.push(fromCenter(s0 + ((s1 - s0) * m) / N, t0));
  for (let m = N; m >= 0; m--)
    ring.push(fromCenter(s0 + ((s1 - s0) * m) / N, t1));
  const M = 12; // close along the inner arc
  for (let m = 1; m <= M; m++)
    ring.push(fromCenter(s0, t1 + ((t0 - t1) * m) / M));
  return cw(ring);
}

function buildScheme(
  kind: InterruptionKind,
  p: GeoProjection,
): CellScheme | null {
  const q = p as unknown as Mutable;

  if (kind === "lobes") {
    const lobes = q.lobes?.();
    if (!Array.isArray(lobes)) return null;
    const table = lobes as number[][][][]; // [hemisphere][lobe][3][lon, lat]
    const rings: Ring[] = [];
    const offset: number[] = [];
    table.forEach((hemisphere, h) => {
      offset.push(rings.length);
      for (const lobe of hemisphere) {
        const west = lobe[0][0] + EPS;
        const east = lobe[2][0] - EPS;
        const pole = lobe[1][1];
        // Clockwise seen from outside: the north goes up its west edge. The equator edge is nudged off the equator: with a rotation [λ, φ, 0] (all a drag can produce) the geographic equator always crosses the rotated equator at the cell corners, and clipping a line exactly through a corner is numerically degenerate.
        const eq = h === 0 ? EPS : -EPS;
        rings.push(
          densify(
            h === 0
              ? [
                  [west, eq],
                  [west, pole],
                  [east, pole],
                  [east, eq],
                  [west, eq],
                ]
              : [
                  [west, eq],
                  [east, eq],
                  [east, pole],
                  [west, pole],
                  [west, eq],
                ],
          ),
        );
      }
    });
    return {
      rings,
      clips: [],
      cellOf(lon, lat) {
        const h = lat < 0 ? 1 : 0;
        const lobe = table[h];
        const last = lobe.length - 1;
        let i = 0;
        while (i < last && lon > lobe[i][2][0]) i++;
        return offset[h] + i;
      },
    };
  }

  if (kind === "healpix") {
    const H = Number(q.lobes?.());
    if (!(H >= 2)) return null;
    const k = 360 / H;
    const rings: Ring[] = [];
    for (let i = 0; i < H; i++) {
      const a = -180 + i * k + EPS;
      const b = -180 + (i + 1) * k - EPS;
      rings.push(
        densify([
          [a, -90],
          [a, 90],
          [b, 90],
          [b, -90],
          [a, -90],
        ]),
      );
    }
    return {
      rings,
      clips: [],
      cellOf: (lon) =>
        Math.min(H - 1, Math.max(0, Math.floor((lon + 180) / k))),
    };
  }

  if (kind === "gingery") {
    const n = Number(q.lobes?.());
    if (!(n >= 2)) return null;
    const k = (2 * Math.PI) / n;
    const rings: Ring[] = [];
    for (let j = 0; j < n; j++) {
      rings.push(
        sectorRing(
          (j - 0.5) * k + EPS_RAD,
          (j + 0.5) * k - EPS_RAD,
          1e-3,
          Math.PI - 1e-3,
        ),
      );
    }
    return {
      rings,
      clips: [],
      cellOf: (lon, lat) => mod(Math.round(bearing(lon, lat) / k), n),
    };
  }

  if (kind === "berghaus") {
    const n = Number(q.lobes?.());
    if (!(n >= 2)) return null;
    const k = (2 * Math.PI) / n;
    const half = Math.PI / 2;
    const rings: Ring[] = [];
    for (let j = 0; j < n; j++) {
      const c = half + j * k;
      rings.push(
        sectorRing(
          c - k / 2 + EPS_RAD,
          c + k / 2 - EPS_RAD,
          half + EPS_RAD,
          Math.PI - 1e-3,
        ),
      );
    }
    // Front hemisphere (|lon| <= 90): continuous, but needs a clip when a
    // feature also reaches into the back sectors.
    const front: Ring = [];
    for (let m = 0; m <= 72; m++)
      front.push(fromCenter(half - EPS_RAD, (m / 72) * 2 * Math.PI));
    rings.push(cw(front));
    return {
      rings,
      clips: [],
      cellOf(lon, lat) {
        if (Math.abs(lon) <= 90) return n;
        return mod(Math.round((bearing(lon, lat) - half) / k), n);
      },
    };
  }

  if (kind === "armadillo") {
    const phi0 = Number(q.parallel?.()) * RAD;
    if (!(phi0 > 0)) return null; // only the northern-parallel form is handled
    const tan0 = Math.tan(phi0);
    // The shell edge. armadilloRaw accepts points down to 1e-3 rad below it; the clip ring stays ABOVE the true edge so that clipped vertices are never misclassified by floating-point error, and the curve is sampled finely because it is very steep near the antimeridian.
    const shell = (lon: number) =>
      -Math.atan2(Math.cos((lon * RAD) / 2), tan0) * DEG;
    const MARGIN = 0.02;
    const edge = (lon: number) => shell(lon) - 1e-3 * DEG; // what cellOf accepts
    const ring: Ring = [];
    for (let lon = -180 + EPS; lon < 180 - EPS; lon += 0.5)
      ring.push([lon, shell(lon) + MARGIN]);
    ring.push(
      [180 - EPS, shell(180 - EPS) + MARGIN],
      [180 - EPS, 90 - 1e-6],
      [-180 + EPS, 90 - 1e-6],
    );
    ring.push(ring[0]);
    return {
      rings: [cw(ring)], // a slit at the antimeridian doubles as the seam cut
      clips: [],
      cellOf: (lon, lat) => (lat > edge(lon) ? 0 : -1),
    };
  }

  if (kind === "littrow") {
    // The hemisphere |lon| < 90 maps to an infinite plane, so keep a finite band.
    const w = -90 + EPS;
    const e = 90 - EPS;
    return {
      rings: [
        densify([
          [w, -LITTROW_LAT],
          [w, LITTROW_LAT],
          [e, LITTROW_LAT],
          [e, -LITTROW_LAT],
          [w, -LITTROW_LAT],
        ]),
      ],
      clips: [],
      cellOf: (lon, lat) =>
        Math.abs(lon) < 90 && Math.abs(lat) < LITTROW_LAT ? 0 : -1,
    };
  }

  return null;
}

const schemeCache = new WeakMap<GeoProjection, CellScheme | null>();
function schemeFor(
  kind: InterruptionKind,
  p: GeoProjection,
): CellScheme | null {
  if (!schemeCache.has(p)) schemeCache.set(p, buildScheme(kind, p));
  return schemeCache.get(p) ?? null;
}

/**
 * The cells of a projection with cuts, as lon/lat rings in the rotated frame (the frame ProjectionScene draws its fixed surface in).
 */
export function cellOutlines(
  projection: GeoProjection,
  kind: InterruptionKind | undefined,
): number[][][] {
  return (kind && schemeFor(kind, projection)?.rings) || [];
}

function clipFor(s: CellScheme, cell: number): unknown {
  return (s.clips[cell] ??= geoClipPolygon({
    type: "Polygon",
    coordinates: [s.rings[cell]],
  }));
}

type Geometry = GeoJSON.GeoJSON;

/** Flatten to single polygons / lines / points so each can be classified. */
function flatten(g: Geometry, out: Geometry[] = []): Geometry[] {
  switch (g.type) {
    case "FeatureCollection":
      for (const f of g.features) if (f.geometry) flatten(f.geometry, out);
      break;
    case "Feature":
      if (g.geometry) flatten(g.geometry, out);
      break;
    case "GeometryCollection":
      for (const x of g.geometries) flatten(x, out);
      break;
    case "MultiPolygon":
      for (const c of g.coordinates)
        out.push({ type: "Polygon", coordinates: c });
      break;
    case "MultiLineString":
      for (const c of g.coordinates)
        out.push({ type: "LineString", coordinates: c });
      break;
    case "MultiPoint":
      for (const c of g.coordinates)
        out.push({ type: "Point", coordinates: c });
      break;
    default:
      out.push(g);
  }
  return out;
}

function eachVertex(g: Geometry, f: (v: number[]) => void) {
  if (g.type === "Polygon")
    for (const r of g.coordinates) for (const v of r) f(v);
  else if (g.type === "LineString") for (const v of g.coordinates) f(v);
  else if (g.type === "Point") f(g.coordinates);
}

const asLines = (g: Geometry): Geometry =>
  g.type === "Polygon"
    ? { type: "MultiLineString", coordinates: g.coordinates }
    : g;

/**
 * Streams geometry through the projection into each target. Projections with cuts (see InterruptionKind) are clipped per cell; everything else is streamed directly.
 */
export function streamGeometry(
  projection: GeoProjection,
  kind: InterruptionKind | undefined,
  geometry: Geometry,
  targets: StreamTarget[],
) {
  const scheme = kind ? schemeFor(kind, projection) : null;
  const feed = (units: Geometry[]) => {
    const streams = targets.map((t) => projection.stream(t.sink));
    for (const u of units) {
      targets.forEach((t, i) =>
        geoStream(t.asLines ? asLines(u) : u, streams[i]),
      );
    }
  };

  if (!scheme) {
    feed(flatten(geometry));
    return;
  }

  const rotate = geoRotation(projection.rotate() as [number, number, number]);
  const plain: Geometry[] = [];
  const perCell = new Map<number, Geometry[]>();

  for (const u of flatten(geometry)) {
    const cells = new Set<number>();
    eachVertex(u, (v) => {
      const [lon, lat] = rotate([v[0], v[1]]);
      cells.add(scheme.cellOf(lon, lat));
    });
    if (cells.size === 1) {
      const [only] = cells;
      if (only >= 0) plain.push(u); // -1: entirely on the hidden side
      continue;
    }
    for (const c of cells) {
      if (c < 0) continue;
      const list = perCell.get(c);
      if (list) list.push(u);
      else perCell.set(c, [u]);
    }
  }

  feed(plain);

  const p = projection as unknown as Mutable;
  const original = p.preclip();
  try {
    for (const [cell, units] of perCell) {
      p.preclip(clipFor(scheme, cell));
      feed(units);
    }
  } finally {
    p.preclip(original);
  }
}

const stitchCache = new WeakMap<object, GeoJSON.FeatureCollection>();

/**
 * Interrupted and HEALPix projections can only follow pole and antimeridian edges once those edges are stitched with extra points. The data never changes, so the result is cached.
 */
export function prepareGeometry(
  kind: InterruptionKind | undefined,
  fc: GeoJSON.FeatureCollection,
): GeoJSON.FeatureCollection {
  if (kind !== "lobes" && kind !== "healpix") return fc;
  let out = stitchCache.get(fc);
  if (!out) {
    out = geoStitch(fc) as GeoJSON.FeatureCollection;
    stitchCache.set(fc, out);
  }
  return out;
}
