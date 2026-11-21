import type { MapColors } from "./map_color";

export type MeasureMode = "none" | "distance" | "area";

export interface SelectOption<T> {
  label: string;
  value: T;
}

export interface SelectGroup<T> {
  label: string;
  options: readonly SelectOption<T>[];
}

export interface MultiLayerMeshBuffers {
  fillVertices: Float32Array;
  fillIndices: Uint32Array;
  borderVertices: Float32Array; // Country political borders
  graticuleVertices: Float32Array; // Lat/Lon grid lines
  geoLineVertices: Float32Array; // Equator, Tropics, Prime Meridian
  tissotVertices: Float32Array;
  tissotIndices: Uint32Array;
}

export interface RenderUniforms {
  viewport: [number, number];
  pan: [number, number];
  zoom: number;
}

export interface MapRenderer {
  readonly backend: "webgpu" | "webgl2";
  updateGeometry(buffers: MultiLayerMeshBuffers): void;
  updateMeasurements(
    lines: Float32Array,
    polyVerts: Float32Array,
    polyIndices: Uint32Array,
  ): void;
  updateMarkers?(data: Float32Array): void;
  setColors?(colors: MapColors): void;
  setGeoLinesVisible?(visible: boolean): void;
  setHoveredMarker?(index: number): void;
  render(uniforms: RenderUniforms): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

export interface GeoData {
  countries: GeoJSON.FeatureCollection;
  geographicLines: GeoJSON.FeatureCollection;
}
