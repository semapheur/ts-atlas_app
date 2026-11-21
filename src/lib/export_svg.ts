import { geoArea, geoCircle, geoPath, type GeoProjection } from "d3-geo";
import type { GeoData } from "./types";
import { TISSOT_ALPHA, type MapColors } from "./map_color";

type XY = [number, number];

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

function tissotGeometry() {
  const geometries: object[] = [];
  const circle = geoCircle().radius(5).precision(2);
  for (let lat = -60; lat <= 60; lat += 30) {
    for (let lon = -150; lon <= 150; lon += 30) {
      geometries.push(circle.center([lon, lat])());
    }
  }
  return { type: "GeometryCollection", geometries } as any;
}

export function buildSvg(o: SvgExportOptions): string {
  const { width: w, height: h, zoom, pan, projection } = o;
  const path = geoPath(projection);
  const cx = w / 2;
  const cy = h / 2;

  // Same transform as the vertex shader: (p - c) * zoom + c + pan
  const transform = `translate(${cx + pan[0]} ${cy + pan[1]}) scale(${zoom}) translate(${-cx} ${-cy})`;
  const ns = `vector-effect="non-scaling-stroke"`;

  const layers: string[] = [];
  const c = o.colors;
  const add = (d: string | null, attrs: string) => {
    if (d) layers.push(`<path d="${d}" ${attrs} ${ns}/>`);
  };

  add(
    path(o.graticule as any),
    `fill="none" stroke="${c.graticule}" stroke-width="1"`,
  );
  add(
    path(o.data.countries as any),
    `fill="${c.land}" stroke="${c.border}" stroke-width="0.8"`,
  );
  if (o.showTissot)
    add(
      path(tissotGeometry()),
      `fill="${c.tissot}" fill-opacity="${TISSOT_ALPHA}" stroke="none"`,
    );
  if (o.showGeoLines)
    add(
      path(o.data.geographicLines as any),
      `fill="none" stroke="${c.geoLines}" stroke-width="1.2"`,
    );

  // Measurements: geoPath follows great-circle arcs and clips for us
  const pts = o.points;
  if (o.measureKind && pts.length >= 2) {
    const closed = o.measureKind === "area" && o.areaClosed && pts.length >= 3;
    if (closed) {
      let ring = [...pts];
      // d3 is winding-order sensitive; keep the smaller of the two regions
      const probe = {
        type: "Polygon",
        coordinates: [[...ring, ring[0]]],
      } as any;
      if (geoArea(probe) > 2 * Math.PI) ring = ring.reverse();
      add(
        path({ type: "Polygon", coordinates: [[...ring, ring[0]]] } as any),
        `fill="${COLORS.measureFill}" stroke="${COLORS.measure}" stroke-width="2.5" stroke-linejoin="round"`,
      );
    } else {
      add(
        path({ type: "LineString", coordinates: pts } as any),
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
