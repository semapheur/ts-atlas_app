import {
  geoAlbers,
  geoAzimuthalEqualArea,
  geoAzimuthalEquidistant,
  geoConicConformal,
  geoConicEqualArea,
  geoConicEquidistant,
  geoEqualEarth,
  geoEquirectangular,
  geoGnomonic,
  geoGraticule,
  geoMercator,
  geoNaturalEarth1,
  geoOrthographic,
  geoProjection,
  geoStereographic,
  geoTransverseMercator,
  type GeoPermissibleObjects,
  type GeoProjection,
} from "d3-geo";

export type ProjectionFamily =
  "cylindrical" | "pseudocylindrical" | "conic" | "planar";
export type ProjectionPerspective =
  "orthographic" | "stereographic" | "gnomonic";
export type ProjectionForm = "tangent" | "secant";

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}
export type ParamValues = Record<string, number>;

export interface ProjectionMeta {
  id: string;
  name: string;
  category: "Conformal" | "Equal-Area" | "Compromise" | "Equidistant";
  family: ProjectionFamily;
  perspective?: ProjectionPerspective;
  form: ProjectionForm;
  standardParallels?: [number, number]; // Latitudes where secant cones/cylinders intersect
  transverse?: boolean;
  description: string;
  /** Fit this instead of the whole sphere (for projections with infinite extent). */
  fitObject?: GeoPermissibleObjects;
  /** Clip drawing to the fit box, cutting off runaway geometry. */
  clipToFit?: boolean;
  params?: ParamDef[];
  parallelsFor?: (v: ParamValues) => [number, number];
  create: (v: ParamValues) => GeoProjection;
}

export function defaultParams(meta: ProjectionMeta): ParamValues {
  return Object.fromEntries((meta.params ?? []).map((p) => [p.id, p.default]));
}

const parallelParams = (a: number, b: number): ParamDef[] => [
  {
    id: "lat1",
    label: "Standard parallel 1",
    min: -89,
    max: 89,
    step: 0.5,
    default: a,
    unit: "°",
  },
  {
    id: "lat2",
    label: "Standard parallel 2",
    min: -89,
    max: 89,
    step: 0.5,
    default: b,
    unit: "°",
  },
];

// Conic conformal sends the south pole to infinity, so fit to a bounded band.
const conformalConicBand = geoGraticule()
  .extent([
    [-180, -60],
    [180, 90],
  ])
  .outline();

function equirectangularRaw(phi1Deg: number) {
  const c = Math.cos((phi1Deg * Math.PI) / 180);
  const raw = (lambda: number, phi: number): [number, number] => [
    lambda * c,
    phi,
  ];
  raw.invert = (x: number, y: number): [number, number] => [x / c, y];
  return raw;
}

export const PROJECTIONS = {
  // Planar (azimuthal)
  orthographic: {
    id: "orthographic",
    name: "Orthographic (Globe)",
    category: "Compromise",
    family: "planar",
    perspective: "orthographic",
    form: "tangent",
    description: "Perspective view from space. Tangent plane projection.",
    create: () => geoOrthographic().scale(220).clipAngle(90),
  },
  stereographic: {
    id: "stereographic",
    name: "Stereographic",
    category: "Conformal",
    family: "planar",
    perspective: "stereographic",
    form: "tangent",
    description:
      "Conformal azimuthal projection. Circles on the globe stay circles; scale grows quickly away from the center.",
    params: [
      {
        id: "clip",
        label: "Clip angle",
        min: 90,
        max: 170,
        step: 1,
        default: 142,
        unit: "°",
      },
    ],
    create: (v) => geoStereographic().clipAngle(v.clip),
  },
  gnomonic: {
    id: "gnomonic",
    name: "Gnomonic",
    category: "Compromise",
    family: "planar",
    perspective: "gnomonic",
    form: "tangent",
    description:
      "Every great circle is a straight line, so shortest routes are easy to read. Only a cap of the globe fits on the plane.",
    params: [
      {
        id: "clip",
        label: "Clip angle",
        min: 20,
        max: 85,
        step: 1,
        default: 60,
        unit: "°",
      },
    ],
    create: (v) => geoGnomonic().clipAngle(v.clip),
  },
  azimuthalEqualArea: {
    id: "azimuthalEqualArea",
    name: "Lambert Azimuthal Equal-Area",
    category: "Equal-Area",
    family: "planar",
    form: "tangent",
    description:
      "Preserves area; the whole globe fits in a disk, with the most shape distortion at the edge.",
    create: () => geoAzimuthalEqualArea(),
  },
  azimuthalEquidistant: {
    id: "azimuthalEquidistant",
    name: "Azimuthal Equidistant",
    category: "Equidistant",
    family: "planar",
    form: "tangent",
    description:
      "Distances and directions from the center point are true. The whole globe fits in a disk.",
    create: () => geoAzimuthalEquidistant(),
  },

  // Cylindrical
  mercator: {
    id: "mercator",
    name: "Mercator",
    category: "Conformal",
    family: "cylindrical",
    form: "tangent",
    standardParallels: [0, 0], // Tangent at the Equator
    description: "Cylindrical projection tangent at the Equator.",
    create: () => geoMercator().scale(140),
  },
  transverseMercator: {
    id: "transverseMercator",
    name: "Transverse Mercator",
    category: "Conformal",
    family: "cylindrical",
    form: "tangent",
    transverse: true,
    description:
      "Mercator turned 90°, so the cylinder touches along a meridian. Accurate near that central meridian.",
    create: () => geoTransverseMercator(),
  },
  equirectangular: {
    id: "equirectangular",
    name: "Equirectangular",
    category: "Equidistant",
    family: "cylindrical",
    form: "tangent",
    standardParallels: [0, 0],
    description:
      "Plate carrée: longitude and latitude map directly to x and y. Distances along meridians are true.",
    params: [
      {
        id: "lat1",
        label: "Standard parallel",
        min: 0,
        max: 80,
        step: 0.5,
        default: 0,
        unit: "°",
      },
    ],
    parallelsFor: (v) => [v.lat1, v.lat1],
    create: (v) => geoProjection(equirectangularRaw(v.lat1)),
  },
  naturalEarth1: {
    id: "naturalEarth1",
    name: "Natural Earth",
    category: "Compromise",
    family: "pseudocylindrical",
    form: "tangent",
    description:
      "Pseudocylindrical compromise projection that balances shape and area distortion.",
    create: () => geoNaturalEarth1(),
  },
  equalEarth: {
    id: "equalEarth",
    name: "Equal Earth",
    category: "Equal-Area",
    family: "pseudocylindrical",
    form: "tangent",
    description:
      "Pseudocylindrical equal-area projection with secant standard parallels.",
    create: () => geoEqualEarth().scale(160),
  },

  // Conic
  albers: {
    id: "albers",
    name: "Albers Equal-Area Conic",
    category: "Equal-Area",
    family: "conic",
    form: "secant",
    standardParallels: [29.5, 45.5], // Classic secant standard parallels
    description:
      "Conic projection intersecting the globe along two standard parallels.",
    params: parallelParams(29.5, 45.5),
    parallelsFor: (v) => [v.lat1, v.lat2],
    create: (v) => geoAlbers().parallels([v.lat1, v.lat2]),
  },
  conicEqualArea: {
    id: "conicEqualArea",
    name: "Conic Equal-Area",
    category: "Equal-Area",
    family: "conic",
    form: "secant",
    standardParallels: [30, 60],
    description:
      "Lambert's equal-area cone with adjustable standard parallels. Unlike Albers, it has no US-specific defaults.",
    params: parallelParams(30, 60),
    parallelsFor: (v) => [v.lat1, v.lat2],
    create: (v) => geoConicEqualArea().parallels([v.lat1, v.lat2]),
  },
  conicConformal: {
    id: "conicConformal",
    name: "Lambert Conformal Conic",
    category: "Conformal",
    family: "conic",
    form: "secant",
    standardParallels: [30, 60],
    description:
      "Conformal cone used for aeronautical charts and mid-latitude regions. One pole maps to infinity, so the view is limited to 60°S and north.",
    fitObject: conformalConicBand,
    clipToFit: true,
    params: parallelParams(30, 60),
    parallelsFor: (v) => [v.lat1, v.lat2],
    create: (v) => geoConicConformal().parallels([v.lat1, v.lat2]),
  },
  conicEquidistant: {
    id: "conicEquidistant",
    name: "Conic Equidistant",
    category: "Equidistant",
    family: "conic",
    form: "secant",
    standardParallels: [30, 60],
    description:
      "Distances along meridians are true, and along the two standard parallels.",
    parallelsFor: (v) => [v.lat1, v.lat2],
    create: (v) => geoConicConformal().parallels([v.lat1, v.lat2]),
  },
} as const satisfies Record<string, ProjectionMeta>;

export type ProjectionId = keyof typeof PROJECTIONS;

export const PROJECTION_LIST = Object.values(PROJECTIONS);

/**
 * Applies rotation and fits the projection to the viewport. Use this in
 * Map.svelte instead of the inline rotate().fitExtent() call.
 */
export function fitProjection(
  meta: ProjectionMeta,
  projection: GeoProjection,
  rotation: [number, number, number],
  width: number,
  height: number,
): void {
  const extent: [[number, number], [number, number]] = [
    [40, 40],
    [width - 40, height - 40],
  ];

  projection
    .rotate(rotation)
    .fitExtent(extent, meta.fitObject ?? { type: "Sphere" });

  // fitExtent computes bounds unclipped, then restores the old clip,
  // so set the new one after fitting.
  projection.clipExtent(meta.clipToFit ? extent : null);
}
