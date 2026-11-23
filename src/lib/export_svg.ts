import {
  geoArea,
  geoCircle,
  geoDistance,
  geoInterpolate,
  type GeoProjection,
  type GeoStream,
} from "d3-geo";
import type { GeoData } from "./types";
import { TISSOT_ALPHA, type MapColors } from "./map_color";
import {
  prepareGeometry,
  streamGeometry,
  type InterruptionKind,
  type StreamTarget,
} from "./interruption";

type XY = [number, number];

const DEG = 180 / Math.PI;

const COLORS = {
  ocean: "#22252a",
  land: "#3d4248",
  border: "#85888f",
  graticule: "#4a4f56",
  geoLine: "#61a5fa",
  tissot: "rgba(250,145,61,0.45)",
  measure: "#f87171",
  measureFill: "rgba(248,113,113,0.25)",
  ink: "#ebe9e4",
  panel: "#33373c",
  marker: "#f05151",
};

export interface SvgExportOptions {
  data: GeoData;
  graticule: object;
  projection: GeoProjection;
  /** ProjectionMeta.interruption: projections with cuts d3 doesn't clip. */
  interruption?: InterruptionKind;
  width: number;
  height: number;
  zoom: number;
  pan: XY;
  showTissot: boolean;
  showGeoLines: boolean;
  measureKind: "distance" | "area" | null;
  points: XY[];
  areaClosed: boolean;
  /** Already in screen space (zoom and pan applied), hidden ones filtered out. */
  markers: { x: number; y: number; index: number }[];
  colors: MapColors;
}

function tissotGeometry(): GeoJSON.GeometryCollection {
  const geometries: GeoJSON.Polygon[] = [];
  const circle = geoCircle().radius(3).precision(2);
  for (let lat = -60; lat <= 60; lat += 20) {
    for (let lon = -150; lon <= 150; lon += 20) {
      geometries.push(circle.center([lon, lat])());
    }
  }
  return { type: "GeometryCollection", geometries };
}

/** A stream sink that writes SVG path data. Polygon rings are closed. */
function pathSink(out: string[]): GeoStream {
  let inPolygon = false;
  let n = 0;
  return {
    point(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      out.push(`${n++ ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`);
    },
    lineStart() {
      n = 0;
    },
    lineEnd() {
      if (inPolygon && n > 0) out.push("Z");
    },
    polygonStart() {
      inPolygon = true;
    },
    polygonEnd() {
      inPolygon = false;
    },
    sphere() {},
  };
}

/**
 * Path data for a geometry, clipped the same way as the on-screen renderer.
 * `fill` follows polygons as polygons; `stroke` follows them as lines, so a
 * cut in an interrupted projection never gets an outline of its own.
 */
function paths(
  o: SvgExportOptions,
  geometry: object,
  want: { fill?: boolean; stroke?: boolean },
): { fill: string; stroke: string } {
  const fill: string[] = [];
  const stroke: string[] = [];
  const targets: StreamTarget[] = [];
  if (want.fill) targets.push({ sink: pathSink(fill) });
  if (want.stroke) targets.push({ sink: pathSink(stroke), asLines: true });
  streamGeometry(
    o.projection,
    o.interruption,
    geometry as GeoJSON.GeoJSON,
    targets,
  );
  return { fill: fill.join(""), stroke: stroke.join("") };
}

/** Great-circle arcs sampled about once per degree, so clipping sees them. */
function densify(pts: XY[], closed: boolean): XY[] {
  const out: XY[] = [];
  const segments = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const steps = Math.min(
      512,
      Math.max(1, Math.ceil(geoDistance(a, b) * DEG)),
    );
    const interp = geoInterpolate(a, b);
    for (let k = 0; k < steps; k++) out.push(interp(k / steps) as XY);
  }
  out.push(closed ? out[0] : pts[pts.length - 1]);
  return out;
}

export function buildSvg(o: SvgExportOptions): string {
  const { width: w, height: h, zoom, pan } = o;
  const cx = w / 2;
  const cy = h / 2;

  // Same transform as the vertex shader: (p - c) * zoom + c + pan
  const transform = `translate(${cx + pan[0]} ${cy + pan[1]}) scale(${zoom}) translate(${-cx} ${-cy})`;
  const ns = `vector-effect="non-scaling-stroke"`;

  const layers: string[] = [];
  const c = o.colors;
  const add = (d: string, attrs: string) => {
    if (d) layers.push(`<path d="${d}" ${attrs} ${ns}/>`);
  };

  add(
    paths(o, o.graticule, { stroke: true }).stroke,
    `fill="none" stroke="${c.graticule}" stroke-width="1"`,
  );

  const land = paths(o, prepareGeometry(o.interruption, o.data.countries), {
    fill: true,
    stroke: true,
  });
  add(land.fill, `fill="${c.land}" fill-rule="evenodd" stroke="none"`);
  add(land.stroke, `fill="none" stroke="${c.border}" stroke-width="0.8"`);

  if (o.showTissot) {
    add(
      paths(o, tissotGeometry(), { fill: true }).fill,
      `fill="${c.tissot}" fill-opacity="${TISSOT_ALPHA}" stroke="none"`,
    );
  }
  if (o.showGeoLines) {
    add(
      paths(o, prepareGeometry(o.interruption, o.data.geographicLines), {
        stroke: true,
      }).stroke,
      `fill="none" stroke="${c.geoLines}" stroke-width="1.2"`,
    );
  }

  // Measurements follow great-circle arcs; densifying lets the clip split
  // them where an interrupted projection has a cut.
  const pts = o.points;
  if (o.measureKind && pts.length >= 2) {
    const closed = o.measureKind === "area" && o.areaClosed && pts.length >= 3;
    if (closed) {
      let ring = [...pts];
      // d3 is winding-order sensitive; keep the smaller of the two regions
      const probe: GeoJSON.Polygon = {
        type: "Polygon",
        coordinates: [[...ring, ring[0]]],
      };
      if (geoArea(probe) > 2 * Math.PI) ring = ring.reverse();
      const polygon: GeoJSON.Polygon = {
        type: "Polygon",
        coordinates: [densify(ring, true)],
      };
      const area = paths(o, polygon, { fill: true, stroke: true });
      add(area.fill, `fill="${COLORS.measureFill}" stroke="none"`);
      add(
        area.stroke,
        `fill="none" stroke="${COLORS.measure}" stroke-width="2.5" stroke-linejoin="round"`,
      );
    } else {
      const line: GeoJSON.LineString = {
        type: "LineString",
        coordinates: densify(pts, false),
      };
      add(
        paths(o, line, { stroke: true }).stroke,
        `fill="none" stroke="${COLORS.measure}" stroke-width="2.5" stroke-linecap="round"`,
      );
    }
  }

  // Markers stay a constant size, so they live outside the zoom group
  const markers = o.markers
    .map(({ x, y, index }) => {
      const text = `#${index + 1}`;
      const lw = 32;
      return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
  <rect x="14" y="-8" width="${lw}" height="16" rx="4" fill="${COLORS.panel}" stroke="#4a4f56"/>
  <text x="20" y="4" fill="${COLORS.ink}" font-family="system-ui, sans-serif" font-size="10" font-weight="600">${text}</text>
  <circle r="8" fill="${COLORS.ink}"/>
  <circle r="6" fill="${COLORS.marker}"/>
</g>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${c.background}"/>
<g transform="${transform}" stroke-linejoin="round">
${layers.join("\n")}
</g>
${markers}
</svg>`;
}
