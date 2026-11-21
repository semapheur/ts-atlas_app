import {
  geoCircle,
  geoStream,
  type GeoProjection,
  type GeoStream,
} from "d3-geo";
import earcut from "earcut";
import type { MultiLayerMeshBuffers } from "./types";

interface TessellationInput {
  countries: GeoJSON.FeatureCollection;
  graticule: GeoJSON.MultiLineString | GeoJSON.FeatureCollection;
  geographicLines?: GeoJSON.FeatureCollection;
  projection: GeoProjection;
  showTissot?: boolean;
}

export function tessellateGeoLayers({
  countries,
  graticule,
  geographicLines,
  projection,
  showTissot = true,
}: TessellationInput): MultiLayerMeshBuffers {
  // Buffers
  const fillVertices: number[] = [];
  const fillIndices: number[] = [];
  const borderVertices: number[] = [];
  const graticuleVertices: number[] = [];
  const geoLineVertices: number[] = [];
  const tissotVertices: number[] = [];
  const tissotIndices: number[] = [];

  // Helper to create a line-segment sink
  function createLineSink(targetArray: number[]): GeoStream {
    let currentRing: number[] = [];
    return {
      point(x, y) {
        if (Number.isFinite(x) && Number.isFinite(y)) currentRing.push(x, y);
      },
      lineStart() {
        currentRing = [];
      },
      lineEnd() {
        if (currentRing.length < 4) return;
        for (let i = 0; i < currentRing.length - 2; i += 2) {
          targetArray.push(
            currentRing[i],
            currentRing[i + 1],
            currentRing[i + 2],
            currentRing[i + 3],
          );
        }
      },
      polygonStart() {},
      polygonEnd() {},
      sphere() {},
    };
  }

  // 1. Countries (Fills + Borders)
  let countryRings: number[][] = [];
  let currentCountryRing: number[] = [];
  let inPolygon = false;

  const countrySink: GeoStream = {
    point(x, y) {
      if (Number.isFinite(x) && Number.isFinite(y))
        currentCountryRing.push(x, y);
    },
    lineStart() {
      currentCountryRing = [];
    },
    lineEnd() {
      if (currentCountryRing.length < 4) return;
      if (inPolygon) {
        countryRings.push(currentCountryRing);
        // Emit border segment pairs
        emitLineSegments(currentCountryRing, true, borderVertices);
      }
    },
    polygonStart() {
      inPolygon = true;
      countryRings = [];
    },
    polygonEnd() {
      inPolygon = false;
      if (countryRings.length > 0) {
        triangulatePolygon(countryRings, fillVertices, fillIndices);
        countryRings = [];
      }
    },
    sphere() {},
  };

  const projectedCountryStream = projection.stream(countrySink);
  for (const feature of countries.features) {
    if (feature.geometry) geoStream(feature.geometry, projectedCountryStream);
  }

  // 2. Graticule Lines
  const graticuleStream = projection.stream(createLineSink(graticuleVertices));
  geoStream(graticule, graticuleStream);

  // 3. Geographic Lines (Equator, Tropics)
  if (geographicLines) {
    const geoLineStream = projection.stream(createLineSink(geoLineVertices));
    geoStream(geographicLines, geoLineStream);
  }

  // 4. Tissot's Indicatrix Circles
  if (showTissot) {
    let tissotRings: number[][] = [];
    let currentTissotRing: number[] = [];

    const tissotSink: GeoStream = {
      point(x, y) {
        if (Number.isFinite(x) && Number.isFinite(y))
          currentTissotRing.push(x, y);
      },
      lineStart() {
        currentTissotRing = [];
      },
      lineEnd() {
        if (currentTissotRing.length >= 4)
          tissotRings.push([...currentTissotRing]);
      },
      polygonStart() {
        tissotRings = [];
      },
      polygonEnd() {
        if (tissotRings.length > 0) {
          triangulatePolygon(tissotRings, tissotVertices, tissotIndices);
          tissotRings = [];
        }
      },
      sphere() {},
    };

    const tissotStream = projection.stream(tissotSink);
    const circleGen = geoCircle().radius(3.0);

    for (let lon = -150; lon <= 150; lon += 30) {
      for (let lat = -60; lat <= 60; lat += 20) {
        circleGen.center([lon, lat]);
        geoStream(circleGen(), tissotStream);
      }
    }
  }

  return {
    fillVertices: new Float32Array(fillVertices),
    fillIndices: new Uint32Array(fillIndices),
    borderVertices: new Float32Array(borderVertices),
    graticuleVertices: new Float32Array(graticuleVertices),
    geoLineVertices: new Float32Array(geoLineVertices),
    tissotVertices: new Float32Array(tissotVertices),
    tissotIndices: new Uint32Array(tissotIndices),
  };
}

// Helpers
function emitLineSegments(ring: number[], close: boolean, out: number[]) {
  for (let i = 0; i < ring.length - 2; i += 2) {
    out.push(ring[i], ring[i + 1], ring[i + 2], ring[i + 3]);
  }
  if (close && ring.length >= 4) {
    const len = ring.length;
    if (ring[0] !== ring[len - 2] || ring[1] !== ring[len - 1]) {
      out.push(ring[len - 2], ring[len - 1], ring[0], ring[1]);
    }
  }
}

function signedArea(ring: number[]): number {
  let a = 0;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
  }
  return a / 2;
}

function ringContains(ring: number[], x: number, y: number): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i],
      yi = ring[i + 1];
    const xj = ring[j],
      yj = ring[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function triangulatePolygon(
  rings: number[][],
  outVerts: number[],
  outIndices: number[],
) {
  // Drop the duplicated closing point and degenerate rings
  const clean: number[][] = [];
  for (const r of rings) {
    let end = r.length;
    if (end >= 4 && r[0] === r[end - 2] && r[1] === r[end - 1]) end -= 2;
    if (end >= 6) clean.push(end === r.length ? r : r.slice(0, end));
  }
  if (clean.length === 0) return;

  // The largest ring is an outline; rings wound the other way are holes.
  const areas = clean.map(signedArea);
  let big = 0;
  for (let i = 1; i < areas.length; i++) {
    if (Math.abs(areas[i]) > Math.abs(areas[big])) big = i;
  }
  const outerSign = Math.sign(areas[big]);

  const outers: { ring: number[]; holes: number[][] }[] = [];
  const holes: number[][] = [];
  clean.forEach((ring, i) => {
    if (Math.sign(areas[i]) === outerSign) outers.push({ ring, holes: [] });
    else holes.push(ring);
  });

  // Attach each hole to the outline that contains it; drop orphans
  for (const h of holes) {
    const owner = outers.find((o) => ringContains(o.ring, h[0], h[1]));
    owner?.holes.push(h);
  }

  for (const { ring, holes } of outers) {
    const flat: number[] = [...ring];
    const holeStarts: number[] = [];
    for (const h of holes) {
      holeStarts.push(flat.length / 2);
      for (const v of h) flat.push(v);
    }
    const tris = earcut(flat, holeStarts.length ? holeStarts : undefined, 2);
    const base = outVerts.length / 2;
    for (let i = 0; i < flat.length; i++) outVerts.push(flat[i]);
    for (let i = 0; i < tris.length; i++) outIndices.push(base + tris[i]);
  }
}
