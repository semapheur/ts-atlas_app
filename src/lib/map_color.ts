export interface MapColors {
  background: string;
  land: string;
  border: string;
  graticule: string;
  geoLines: string;
  tissot: string;
}

export const DEFAULT_MAP_COLORS: MapColors = {
  background: "#22252a",
  land: "#3d4248",
  border: "#85888f",
  graticule: "#4a4f56",
  geoLines: "#61a5fa",
  tissot: "#fa913d",
};

export const TISSOT_ALPHA = 0.45;

/** "#rrggbb" -> 0..1 components (what <input type="color"> produces). */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
