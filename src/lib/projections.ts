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
import {
  geoAiry,
  geoAitoff,
  geoArmadillo,
  geoAugust,
  geoBaker,
  geoBerghaus,
  geoBertin1953,
  geoBoggs,
  geoBonne,
  geoBottomley,
  geoBromley,
  geoCollignon,
  geoCraster,
  geoCylindricalEqualArea,
  geoCylindricalStereographic,
  geoEckert1,
  geoEckert2,
  geoEckert3,
  geoEckert4,
  geoEckert5,
  geoEckert6,
  geoEisenlohr,
  geoFahey,
  geoFoucaut,
  geoFoucautSinusoidal,
  geoGingery,
  geoGinzburg4,
  geoGinzburg5,
  geoGinzburg6,
  geoGinzburg8,
  geoGinzburg9,
  geoGringorten,
  geoGuyou,
  geoHammer,
  geoHealpix,
  geoHill,
  geoHomolosine,
  geoInterruptedHomolosine,
  geoInterruptedMollweide,
  geoInterruptedMollweideHemispheres,
  geoInterruptedSinusoidal,
  geoKavrayskiy7,
  geoLagrange,
  geoLarrivee,
  geoLaskowski,
  geoLittrow,
  geoLoximuthal,
  geoMiller,
  geoMollweide,
  geoMtFlatPolarParabolic,
  geoMtFlatPolarQuartic,
  geoMtFlatPolarSinusoidal,
  geoNaturalEarth2,
  geoNellHammer,
  geoPatterson,
  geoPeirceQuincuncial,
  geoPolyconic,
  geoRectangularPolyconic,
  geoRobinson,
  geoSatellite,
  geoSinuMollweide,
  geoSinusoidal,
  geoTimes,
  geoVanDerGrinten,
  geoVanDerGrinten2,
  geoVanDerGrinten3,
  geoVanDerGrinten4,
  geoWagner,
  geoWagner4,
  geoWagner6,
  geoWagner7,
  geoWiechel,
  geoWinkel3,
} from "d3-geo-projection";
import { LITTROW_LAT, type InterruptionKind } from "./interruption";

export type ProjectionFamily =
  | "cylindrical"
  | "pseudocylindrical"
  | "conic"
  | "planar"
  | "pseudoazimuthal"
  | "interrupted"
  | "other";
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
  /** fitObject is expressed in the projection's rotated frame (not geographic). */
  fitInRotatedFrame?: boolean;
  /** Projection has cuts / bounds that d3 doesn't clip; see interruption.ts. */
  interruption?: InterruptionKind;
  params?: ParamDef[];
  parallelsFor?: (v: ParamValues) => [number, number];
  create: (v: ParamValues) => GeoProjection;
}

export function defaultParams(meta: ProjectionMeta): ParamValues {
  return Object.fromEntries((meta.params ?? []).map((p) => [p.id, p.default]));
}

/**
 * The rotation a projection ships with. Several d3-geo-projection factories
 * (Briesemeister, Bertin 1953, Armadillo, Peirce, ...) set their own default
 * rotation, which fitProjection would otherwise overwrite with [0, 0, 0].
 */
export function initialRotation(
  meta: ProjectionMeta,
): [number, number, number] {
  const [lambda = 0, phi = 0, gamma = 0] = meta
    .create(defaultParams(meta))
    .rotate();
  return [lambda, phi, gamma];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const slider = (
  id: string,
  label: string,
  min: number,
  max: number,
  step: number,
  def: number,
  unit?: string,
): ParamDef => ({ id, label, min, max, step, default: def, unit });

const parallelParams = (a: number, b: number): ParamDef[] => [
  slider("lat1", "Standard parallel 1", -89, 89, 0.5, a, "°"),
  slider("lat2", "Standard parallel 2", -89, 89, 0.5, b, "°"),
];

const singleParallel = (
  label: string,
  min: number,
  max: number,
  def: number,
  step = 0.5,
): ParamDef[] => [slider("lat1", label, min, max, step, def, "°")];

/**
 * Calls each named configuration method on a projection. d3-geo-projection's
 * extra setters (radius, lobes, parallel, ...) are not on the base GeoProjection
 * type, and typings for them vary between versions.
 */
function tune(p: GeoProjection, setters: Record<string, unknown>) {
  const o = p as unknown as Record<string, (v: unknown) => unknown>;
  for (const [name, value] of Object.entries(setters)) o[name](value);
  return p;
}

function make(
  id: string,
  name: string,
  category: ProjectionMeta["category"],
  family: ProjectionFamily,
  description: string,
  create: ProjectionMeta["create"],
  extra: Partial<ProjectionMeta> = {},
): ProjectionMeta {
  return {
    id,
    name,
    category,
    family,
    form: "tangent",
    description,
    create,
    ...extra,
  };
}

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

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const PROJECTIONS = {
  // ===== Planar (azimuthal) =====
  orthographic: {
    id: "orthographic",
    name: "Orthographic (Globe)",
    category: "Compromise",
    family: "planar",
    perspective: "orthographic",
    form: "tangent",
    description: "Perspective view from space. Tangent plane projection.",
    params: [slider("clip", "Clip angle", 20, 90, 1, 90, "°")],
    create: (v) => geoOrthographic().clipAngle(v.clip),
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
    params: [slider("clip", "Clip angle", 90, 170, 1, 142, "°")],
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
    params: [slider("clip", "Clip angle", 20, 85, 1, 60, "°")],
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
    params: [slider("clip", "Clip angle", 30, 180, 1, 180, "°")],
    create: (v) =>
      geoAzimuthalEqualArea().clipAngle(Math.min(v.clip, 180 - 1e-3)),
  },
  azimuthalEquidistant: {
    id: "azimuthalEquidistant",
    name: "Azimuthal Equidistant",
    category: "Equidistant",
    family: "planar",
    form: "tangent",
    description:
      "Distances and directions from the center point are true. The whole globe fits in a disk.",
    params: [slider("clip", "Clip angle", 30, 180, 1, 180, "°")],
    create: (v) =>
      geoAzimuthalEquidistant().clipAngle(Math.min(v.clip, 180 - 1e-3)),
  },
  airy: make(
    "airy",
    "Airy (Minimum Error)",
    "Compromise",
    "planar",
    "Azimuthal projection that minimizes total distortion within a chosen radius around the center.",
    (v) => tune(geoAiry(), { radius: v.radius }),
    { params: [slider("radius", "Minimized radius", 10, 170, 1, 90, "°")] },
  ),
  berghaus: make(
    "berghaus",
    "Berghaus Star",
    "Equidistant",
    "planar",
    "Azimuthal equidistant centered on the pole, with the southern hemisphere cut into star points.",
    (v) => tune(geoBerghaus(), { lobes: v.lobes }),
    {
      interruption: "berghaus",
      params: [slider("lobes", "Lobes", 3, 12, 1, 5)],
    },
  ),
  satellite: make(
    "satellite",
    "Satellite (Tilted Perspective)",
    "Compromise",
    "planar",
    "General perspective view from a finite height above the globe, optionally tilted.",
    (v) => tune(geoSatellite(), { distance: v.distance, tilt: v.tilt }),
    {
      params: [
        slider("distance", "Distance (Earth radii)", 1.05, 6, 0.05, 1.4),
        slider("tilt", "Tilt", 0, 60, 1, 0, "°"),
      ],
    },
  ),

  // ===== Cylindrical =====
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
    params: singleParallel("Standard parallel", 0, 80, 0),
    parallelsFor: (v) => [v.lat1, v.lat1],
    create: (v) => geoProjection(equirectangularRaw(v.lat1)),
  },
  cylindricalEqualArea: make(
    "cylindricalEqualArea",
    "Cylindrical Equal-Area",
    "Equal-Area",
    "cylindrical",
    "Equal-area cylinder. 0° gives Lambert, 30° Behrmann, 37.5° Hobo–Dyer, 45° Gall–Peters.",
    (v) => tune(geoCylindricalEqualArea(), { parallel: v.lat1 }),
    {
      form: "secant",
      standardParallels: [38.58, 38.58],
      params: singleParallel("Standard parallel", 0, 80, 38.58, 0.01),
      parallelsFor: (v) => [v.lat1, v.lat1],
    },
  ),
  cylindricalStereographic: make(
    "cylindricalStereographic",
    "Cylindrical Stereographic",
    "Compromise",
    "cylindrical",
    "Perspective cylinder projected from the antipode of the opposite meridian. 0° gives Braun, 30° Gall stereographic.",
    (v) => tune(geoCylindricalStereographic(), { parallel: v.lat1 }),
    {
      form: "secant",
      standardParallels: [0, 0],
      params: singleParallel("Standard parallel", 0, 80, 0),
      parallelsFor: (v) => [v.lat1, v.lat1],
    },
  ),
  miller: make(
    "miller",
    "Miller",
    "Compromise",
    "cylindrical",
    "Mercator-like cylinder with the poles brought to finite positions.",
    () => geoMiller(),
    { standardParallels: [0, 0] },
  ),

  // ===== Pseudocylindrical =====
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
  naturalEarth2: make(
    "naturalEarth2",
    "Natural Earth II",
    "Compromise",
    "pseudocylindrical",
    "Successor to Natural Earth with a slightly narrower, rounder outline.",
    () => geoNaturalEarth2(),
  ),
  robinson: make(
    "robinson",
    "Robinson",
    "Compromise",
    "pseudocylindrical",
    "Classic compromise world map, defined by a lookup table rather than a formula.",
    () => geoRobinson(),
  ),
  patterson: make(
    "patterson",
    "Patterson Cylindrical",
    "Compromise",
    "pseudocylindrical",
    "Modern compromise projection designed as a gentler alternative to Miller.",
    () => geoPatterson(),
  ),
  kavrayskiy7: make(
    "kavrayskiy7",
    "Kavrayskiy VII",
    "Compromise",
    "pseudocylindrical",
    "Compromise projection with a 1.73:1 aspect ratio, widely used in Russian atlases.",
    () => geoKavrayskiy7(),
  ),
  nellHammer: make(
    "nellHammer",
    "Nell–Hammer",
    "Compromise",
    "pseudocylindrical",
    "Average of the sinusoidal and Mollweide-like behavior; a mild compromise.",
    () => geoNellHammer(),
  ),
  times: make(
    "times",
    "Times",
    "Compromise",
    "pseudocylindrical",
    "Compromise projection designed for The Times Atlas, close to Gall stereographic.",
    () => geoTimes(),
  ),
  mollweide: make(
    "mollweide",
    "Mollweide",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area ellipse with straight parallels; shapes are sheared near the edges.",
    () => geoMollweide(),
  ),
  sinusoidal: make(
    "sinusoidal",
    "Sinusoidal",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area with true scale along every parallel and the central meridian; strong shearing far from the center.",
    () => geoSinusoidal(),
  ),
  sinuMollweide: make(
    "sinuMollweide",
    "Sinu-Mollweide",
    "Equal-Area",
    "pseudocylindrical",
    "Sinusoidal in the tropics blended into Mollweide toward the poles.",
    () => geoSinuMollweide(),
  ),
  homolosine: make(
    "homolosine",
    "Goode Homolosine",
    "Equal-Area",
    "pseudocylindrical",
    "Sinusoidal at low latitudes joined to Mollweide at high latitudes.",
    () => geoHomolosine(),
  ),
  boggs: make(
    "boggs",
    "Boggs Eumorphic",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area average of sinusoidal and Mollweide with pointed poles.",
    () => geoBoggs(),
  ),
  collignon: make(
    "collignon",
    "Collignon",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area projection whose graticule is a set of straight lines forming a diamond.",
    () => geoCollignon(),
  ),
  craster: make(
    "craster",
    "Craster Parabolic",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area projection with parabolic meridians.",
    () => geoCraster(),
  ),
  bromley: make(
    "bromley",
    "Bromley",
    "Equal-Area",
    "pseudocylindrical",
    "Mollweide variant with an adjusted aspect ratio.",
    () => geoBromley(),
  ),
  foucaut: make(
    "foucaut",
    "Foucaut Stereographic Equivalent",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area projection with the stereographic-like look of Foucaut's design.",
    () => geoFoucaut(),
  ),
  foucautSinusoidal: make(
    "foucautSinusoidal",
    "Foucaut Sinusoidal",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area blend between the sinusoidal (0) and the cylindrical equal-area (1).",
    (v) => tune(geoFoucautSinusoidal(), { alpha: v.alpha }),
    { params: [slider("alpha", "Blend (α)", 0, 1, 0.01, 0.5)] },
  ),
  eckert1: make(
    "eckert1",
    "Eckert I",
    "Compromise",
    "pseudocylindrical",
    "Pseudocylindrical with straight-line meridians; neither equal-area nor conformal.",
    () => geoEckert1(),
  ),
  eckert2: make(
    "eckert2",
    "Eckert II",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area counterpart of Eckert I with straight meridians.",
    () => geoEckert2(),
  ),
  eckert3: make(
    "eckert3",
    "Eckert III",
    "Compromise",
    "pseudocylindrical",
    "Elliptical meridians, with poles as lines half the length of the equator.",
    () => geoEckert3(),
  ),
  eckert4: make(
    "eckert4",
    "Eckert IV",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area with elliptical meridians.",
    () => geoEckert4(),
  ),
  eckert5: make(
    "eckert5",
    "Eckert V",
    "Compromise",
    "pseudocylindrical",
    "Sinusoidal meridians with a compromise parallel spacing.",
    () => geoEckert5(),
  ),
  eckert6: make(
    "eckert6",
    "Eckert VI",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area with sinusoidal meridians.",
    () => geoEckert6(),
  ),
  fahey: make(
    "fahey",
    "Fahey",
    "Compromise",
    "pseudocylindrical",
    "Pseudocylindrical compromise with straight-line, tapering meridians.",
    () => geoFahey(),
  ),
  larrivee: make(
    "larrivee",
    "Larrivée",
    "Compromise",
    "pseudocylindrical",
    "Compromise projection averaging sinusoidal and a pseudocylindrical form.",
    () => geoLarrivee(),
  ),
  ginzburg4: make(
    "ginzburg4",
    "Ginzburg IV",
    "Compromise",
    "pseudocylindrical",
    "Soviet-era compromise projection with curved meridians.",
    () => geoGinzburg4(),
  ),
  ginzburg5: make(
    "ginzburg5",
    "Ginzburg V",
    "Compromise",
    "pseudocylindrical",
    "Soviet-era compromise projection.",
    () => geoGinzburg5(),
  ),
  ginzburg6: make(
    "ginzburg6",
    "Ginzburg VI",
    "Compromise",
    "pseudocylindrical",
    "Soviet-era compromise projection.",
    () => geoGinzburg6(),
  ),
  ginzburg8: make(
    "ginzburg8",
    "Ginzburg VIII",
    "Compromise",
    "pseudocylindrical",
    "Soviet-era compromise projection.",
    () => geoGinzburg8(),
  ),
  ginzburg9: make(
    "ginzburg9",
    "Ginzburg IX",
    "Compromise",
    "pseudocylindrical",
    "Soviet-era compromise projection.",
    () => geoGinzburg9(),
  ),
  mtFlatPolarParabolic: make(
    "mtFlatPolarParabolic",
    "McBryde–Thomas Flat-Polar Parabolic",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area with parabolic meridians and flat poles.",
    () => geoMtFlatPolarParabolic(),
  ),
  mtFlatPolarQuartic: make(
    "mtFlatPolarQuartic",
    "McBryde–Thomas Flat-Polar Quartic",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area with quartic meridians and flat poles.",
    () => geoMtFlatPolarQuartic(),
  ),
  mtFlatPolarSinusoidal: make(
    "mtFlatPolarSinusoidal",
    "McBryde–Thomas Flat-Polar Sinusoidal",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area with sinusoidal meridians and flat poles.",
    () => geoMtFlatPolarSinusoidal(),
  ),
  wagner4: make(
    "wagner4",
    "Wagner IV",
    "Equal-Area",
    "pseudocylindrical",
    "Equal-area pseudocylindrical, with a rounded outline.",
    () => geoWagner4(),
  ),
  wagner6: make(
    "wagner6",
    "Wagner VI",
    "Compromise",
    "pseudocylindrical",
    "Compromise projection with an elliptical outline.",
    () => geoWagner6(),
  ),
  wagner: make(
    "wagner",
    "Wagner (Adjustable)",
    "Compromise",
    "pseudocylindrical",
    "Generalized Wagner family: tune pole line, standard parallels, inflation and aspect ratio.",
    (v) =>
      tune(geoWagner(), {
        poleline: v.poleline,
        parallels: v.parallels,
        inflation: v.inflation,
        ratio: v.ratio,
      }),
    {
      params: [
        slider("poleline", "Pole line", 20, 85, 1, 65, "°"),
        slider("parallels", "Standard parallels", 20, 85, 1, 60, "°"),
        slider("inflation", "Inflation", 0, 45, 1, 20, "°"),
        slider("ratio", "Aspect ratio", 100, 300, 5, 200),
      ],
    },
  ),

  // ===== Pseudoazimuthal / modified azimuthal =====
  aitoff: make(
    "aitoff",
    "Aitoff",
    "Compromise",
    "pseudoazimuthal",
    "Equatorial azimuthal equidistant stretched horizontally into an ellipse.",
    () => geoAitoff(),
  ),
  winkel3: make(
    "winkel3",
    "Winkel Tripel",
    "Compromise",
    "pseudoazimuthal",
    "Average of equirectangular and Aitoff; the National Geographic Society's choice for world maps.",
    () => geoWinkel3(),
  ),
  hammer: make(
    "hammer",
    "Hammer",
    "Equal-Area",
    "pseudoazimuthal",
    "Equal-area ellipse built from the Lambert azimuthal. Higher coefficients give a more elongated map.",
    (v) => tune(geoHammer(), { coefficient: v.coefficient }),
    { params: [slider("coefficient", "Coefficient", 1, 6, 0.1, 2)] },
  ),
  wiechel: make(
    "wiechel",
    "Wiechel",
    "Equal-Area",
    "pseudoazimuthal",
    "Equal-area pseudoazimuthal with a distinctive swirl of curved meridians.",
    () => geoWiechel(),
  ),
  wagner7: make(
    "wagner7",
    "Wagner VII",
    "Equal-Area",
    "pseudoazimuthal",
    "Modified azimuthal equal-area (Hammer–Wagner) with a hexagonal-ish outline.",
    () => geoWagner7(),
  ),
  laskowski: make(
    "laskowski",
    "Laskowski Tri-Optimal",
    "Compromise",
    "pseudoazimuthal",
    "Polynomial compromise designed to minimize area, angle and distance error together.",
    () => geoLaskowski(),
  ),
  bottomley: make(
    "bottomley",
    "Bottomley",
    "Equal-Area",
    "pseudoazimuthal",
    "Equal-area projection with a tunable sinuosity of the parallels.",
    (v) => tune(geoBottomley(), { sinuosity: v.sinuosity }),
    { params: [slider("sinuosity", "Sinuosity", 0.1, 1.5, 0.01, 0.7)] },
  ),

  // ===== Conic =====
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
    params: parallelParams(30, 60),
    parallelsFor: (v) => [v.lat1, v.lat2],
    // Was geoConicConformal; geoConicEquidistant was imported but unused.
    create: (v) => geoConicEquidistant().parallels([v.lat1, v.lat2]),
  },
  bonne: make(
    "bonne",
    "Bonne",
    "Equal-Area",
    "conic",
    "Pseudoconic equal-area projection. A parallel of 0° gives the sinusoidal; 90° gives the heart-shaped Werner.",
    (v) => tune(geoBonne(), { parallel: v.lat1 }),
    {
      standardParallels: [45, 45],
      params: singleParallel("Standard parallel", 0, 89, 45),
      parallelsFor: (v) => [v.lat1, v.lat1],
    },
  ),

  // ===== Interrupted =====
  interruptedHomolosine: make(
    "interruptedHomolosine",
    "Interrupted Goode Homolosine",
    "Equal-Area",
    "interrupted",
    "Homolosine with cuts through the oceans to reduce distortion over land.",
    () => geoInterruptedHomolosine(),
    { interruption: "lobes" },
  ),
  interruptedMollweide: make(
    "interruptedMollweide",
    "Interrupted Mollweide",
    "Equal-Area",
    "interrupted",
    "Mollweide cut into lobes centered on the continents.",
    () => geoInterruptedMollweide(),
    { interruption: "lobes" },
  ),
  interruptedMollweideHemispheres: make(
    "interruptedMollweideHemispheres",
    "Interrupted Mollweide Hemispheres",
    "Equal-Area",
    "interrupted",
    "Two Mollweide hemispheres side by side, one for the east and one for the west.",
    () => geoInterruptedMollweideHemispheres(),
    { interruption: "lobes" },
  ),
  interruptedSinusoidal: make(
    "interruptedSinusoidal",
    "Interrupted Sinusoidal",
    "Equal-Area",
    "interrupted",
    "Sinusoidal with oceanic interruptions, which sharply reduces shearing.",
    () => geoInterruptedSinusoidal(),
    { interruption: "lobes" },
  ),

  // ===== Other (conformal world maps, polyconic, circular, ...) =====
  polyconic: make(
    "polyconic",
    "American Polyconic",
    "Compromise",
    "other",
    "Each parallel is the standard line of its own tangent cone; true scale along the central meridian and every parallel.",
    () => geoPolyconic(),
  ),
  rectangularPolyconic: make(
    "rectangularPolyconic",
    "Rectangular Polyconic",
    "Compromise",
    "other",
    "Polyconic variant in which the parallels meet the meridians at right angles along a chosen parallel.",
    (v) => tune(geoRectangularPolyconic(), { parallel: v.lat1 }),
    { params: singleParallel("Standard parallel", -80, 80, 0) },
  ),
  loximuthal: make(
    "loximuthal",
    "Loximuthal",
    "Compromise",
    "other",
    "Rhumb lines from the central point are straight and true to scale.",
    (v) => tune(geoLoximuthal(), { parallel: v.lat1 }),
    { params: singleParallel("Central parallel", -80, 80, 40) },
  ),
  vanDerGrinten: make(
    "vanDerGrinten",
    "Van der Grinten I",
    "Compromise",
    "other",
    "Circular compromise map; strongly enlarges the polar regions.",
    () => geoVanDerGrinten(),
  ),
  vanDerGrinten2: make(
    "vanDerGrinten2",
    "Van der Grinten II",
    "Compromise",
    "other",
    "Variant with parallels spaced to reduce polar exaggeration.",
    () => geoVanDerGrinten2(),
  ),
  vanDerGrinten3: make(
    "vanDerGrinten3",
    "Van der Grinten III",
    "Compromise",
    "other",
    "Variant with straight-line parallel spacing.",
    () => geoVanDerGrinten3(),
  ),
  vanDerGrinten4: make(
    "vanDerGrinten4",
    "Van der Grinten IV",
    "Compromise",
    "other",
    "Variant with a polar-friendly meridian layout.",
    () => geoVanDerGrinten4(),
  ),
  armadillo: make(
    "armadillo",
    "Armadillo",
    "Compromise",
    "other",
    "Raisz's orthographic-like armadillo-shell map; the tilted parallels set where the shell rolls.",
    (v) => tune(geoArmadillo(), { parallel: v.lat1 }),
    {
      interruption: "armadillo",
      params: singleParallel("Parallel", 5, 80, 20),
    },
  ),
  baker: make(
    "baker",
    "Baker Dinomic",
    "Compromise",
    "other",
    "Compromise map with a distinctive pointed outline.",
    () => geoBaker(),
  ),
  bertin1953: make(
    "bertin1953",
    "Bertin 1953",
    "Compromise",
    "other",
    "Jacques Bertin's oblique design which gently warps oceans to emphasize landmasses.",
    () => geoBertin1953(),
  ),
  healpix: make(
    "healpix",
    "HEALPix",
    "Equal-Area",
    "other",
    "Hierarchical equal-area projection from astronomy; the lobes control the number of polar flaps.",
    (v) => tune(geoHealpix(), { lobes: v.lobes }),
    {
      interruption: "healpix",
      params: [slider("lobes", "Lobes", 3, 8, 1, 4)],
    },
  ),
  hill: make(
    "hill",
    "Hill Eucyclic",
    "Compromise",
    "other",
    "Eucyclic family; the ratio sets how strongly the circular arcs bend. A ratio of 0 approaches the sinusoidal.",
    (v) => tune(geoHill(), { ratio: v.ratio }),
    { params: [slider("ratio", "Ratio", 0.2, 4, 0.05, 1)] },
  ),
  gingery: make(
    "gingery",
    "Gingery",
    "Compromise",
    "other",
    "Central disc with a ring of lobes; radius sets the disc size and lobes the ring segmentation.",
    (v) => tune(geoGingery(), { radius: v.radius, lobes: v.lobes }),
    {
      interruption: "gingery",
      params: [
        slider("radius", "Disc radius", 5, 60, 1, 30, "°"),
        slider("lobes", "Lobes", 3, 12, 1, 6),
      ],
    },
  ),
  gringorten: make(
    "gringorten",
    "Gringorten Square",
    "Equal-Area",
    "other",
    "Equal-area projection that fits the globe inside a square.",
    () => geoGringorten(),
  ),
  guyou: make(
    "guyou",
    "Guyou Hemisphere-in-a-Square",
    "Conformal",
    "other",
    "Conformal projection of a hemisphere into a square.",
    () => geoGuyou(),
  ),
  peirceQuincuncial: make(
    "peirceQuincuncial",
    "Peirce Quincuncial",
    "Conformal",
    "other",
    "Conformal whole-world square that tiles the plane.",
    () => geoPeirceQuincuncial(),
  ),
  lagrange: make(
    "lagrange",
    "Lagrange",
    "Conformal",
    "other",
    "Conformal projection of the world into a circle. Spacing adjusts how much the hemispheres overlap.",
    (v) => tune(geoLagrange(), { spacing: v.spacing }),
    { params: [slider("spacing", "Spacing", 0.05, 0.95, 0.01, 0.5)] },
  ),
  august: make(
    "august",
    "August Epicycloidal",
    "Conformal",
    "other",
    "Conformal projection fitting the whole globe in a lens-like epicycloidal outline.",
    () => geoAugust(),
  ),
  eisenlohr: make(
    "eisenlohr",
    "Eisenlohr",
    "Conformal",
    "other",
    "Conformal projection with a rounded outline and low distortion in the center.",
    () => geoEisenlohr(),
  ),
  littrow: make(
    "littrow",
    "Littrow",
    "Conformal",
    "other",
    "Conformal retroazimuthal: from every point, the direction to the center is the true bearing. The plane is unbounded, so only the band within 70° of the equator is drawn.",
    () => geoLittrow(),
    {
      interruption: "littrow",
      fitInRotatedFrame: true,
      fitObject: geoGraticule()
        .extent([
          [-90, -LITTROW_LAT],
          [90, LITTROW_LAT],
        ])
        .outline(),
    },
  ),
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

  // Some fit objects (Littrow's band) are defined in the rotated frame, so
  // fit with no rotation, then apply the real one.
  projection
    .rotate(meta.fitInRotatedFrame ? [0, 0, 0] : rotation)
    .fitExtent(extent, meta.fitObject ?? { type: "Sphere" })
    .rotate(rotation);

  // fitExtent computes bounds unclipped, then restores the old clip,
  // so set the new one after fitting.
  projection.clipExtent(meta.clipToFit ? extent : null);
}
