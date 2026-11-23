<script lang="ts">
  import { onMount } from "svelte";
  import * as THREE from "three";
  import type {
    ProjectionFamily,
    ProjectionForm,
    ProjectionPerspective,
  } from "../projections";

  interface Props {
    rotation: [number, number, number];
    family: ProjectionFamily;
    form: ProjectionForm;
    standardParallels?: [number, number];
    clipAngle?: number;
    perspective?: ProjectionPerspective;
    transverse?: boolean;
    /** Cell outlines (lon/lat rings, rotated frame) of projections with cuts. */
    cells?: number[][][];
  }

  let {
    rotation,
    family,
    form,
    standardParallels = [0, 0],
    clipAngle,
    perspective,
    transverse = false,
    cells = [],
  }: Props = $props();

  const DEG = Math.PI / 180;
  const CONTACT = 0xea580c;
  const RAY = 0xf59e0b;
  const V3 = THREE.Vector3;
  const V2 = THREE.Vector2;
  const DEFAULT_CLIP = { orthographic: 90, stereographic: 142, gnomonic: 60 };
  const MAX_PLANE_R = 3; // drawing cap: stereographic/gnomonic radii blow up
  const PSEUDO_STRETCH = 2; // pseudoazimuthal maps are drawn as a 2:1 ellipse

  let container: HTMLDivElement;
  let renderer: THREE.WebGLRenderer | undefined;

  // Frame (same as d3 after rotation): +y north pole, +z toward the projection center, +x east. The globe rotates; the surface is fixed.
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const earthGroup = new THREE.Group();
  const surfaceGroup = new THREE.Group();
  scene.add(earthGroup, surfaceGroup);
  earthGroup.rotation.order = "ZXY"; // matrix = Rz · Rx · Ry, like d3

  function render() {
    renderer?.render(scene, camera);
  }

  // helpers
  function lonLat(lon: number, lat: number) {
    const l = lon * DEG;
    const p = lat * DEG;
    return new V3(
      Math.cos(p) * Math.sin(l),
      Math.sin(p),
      Math.cos(p) * Math.cos(l),
    );
  }

  function radiusAt(persp: ProjectionPerspective, thetaDeg: number) {
    const t = thetaDeg * DEG;
    return persp === "orthographic"
      ? Math.sin(t)
      : persp === "stereographic"
        ? 2 * Math.tan(t / 2)
        : Math.tan(t);
  }

  /** Largest angle we can draw before the plane exceeds MAX_PLANE_R. */
  function thetaForRadius(persp: ProjectionPerspective, r: number) {
    return persp === "orthographic"
      ? 90
      : persp === "stereographic"
        ? (2 * Math.atan(r / 2)) / DEG
        : Math.atan(r) / DEG;
  }

  function lineMat(color: number, opacity: number) {
    return new THREE.LineBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      depthWrite: false,
    });
  }

  function polyline(
    pts: THREE.Vector3[],
    color: number,
    opacity = 1,
    loop = false,
  ) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = lineMat(color, opacity);
    return loop ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat);
  }

  function segments(pts: THREE.Vector3[], color: number, opacity = 1) {
    return new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      lineMat(color, opacity),
    );
  }

  function surfaceMaterial() {
    return new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  function dot(pos: THREE.Vector3, radius: number, color: number) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 12, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    m.position.copy(pos);
    return m;
  }

  function clearGroup(group: THREE.Group) {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) =>
          x.dispose(),
        );
      });
    }
  }

  const arc = (f: (t: number) => THREE.Vector3, n: number) =>
    Array.from({ length: n + 1 }, (_, i) => f(i / n));

  function buildGlobe() {
    earthGroup.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(1, 48, 32),
        new THREE.MeshBasicMaterial({
          color: 0xf1f5f9,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
        }),
      ),
    );

    for (let lat = -60; lat <= 60; lat += 30) {
      earthGroup.add(
        polyline(
          arc((t) => lonLat(-180 + 360 * t, lat), 96),
          lat === 0 ? 0x334155 : 0x64748b,
          lat === 0 ? 0.9 : 0.35,
        ),
      );
    }
    for (let lon = -180; lon < 180; lon += 30) {
      earthGroup.add(
        polyline(
          arc((t) => lonLat(lon, -90 + 180 * t), 48),
          lon === 0 ? 0xdc2626 : 0x64748b,
          lon === 0 ? 1 : 0.35,
        ),
      );
    }
    // Orientation cue: lon 0, lat 0
    earthGroup.add(dot(lonLat(0, 0), 0.035, 0xdc2626));

    earthGroup.add(
      segments([new V3(0, -1.35, 0), new V3(0, 1.35, 0)], 0x0f172a, 0.8),
      dot(new V3(0, 1, 0), 0.04, 0x0f172a), // north pole
    );
  }

  // cylinders and cones
  interface Developable {
    a: THREE.Vector2; // (radius, y) of one end of the drawn band
    b: THREE.Vector2;
    contacts: number[]; // latitudes where the surface meets the sphere
  }

  function developable(lat1: number, lat2: number): Developable {
    const cylinder = (r: number, contacts: number[]): Developable => ({
      a: new V2(r, -1.4),
      b: new V2(r, 1.4),
      contacts,
    });

    const frustum = (
      apex: THREE.Vector2,
      pts: THREE.Vector2[],
      lats: number[],
    ) => {
      // Draw from a bit past the contact circle nearest the equator toward the apex, capped so near-cylindrical cones stay on screen.
      const outer = pts.reduce((p, c) =>
        c.distanceTo(apex) > p.distanceTo(apex) ? c : p,
      );
      const inner = pts.find((c) => c !== outer) ?? outer;
      const u = apex.clone().sub(outer).normalize();
      const len = Math.min(
        outer.distanceTo(apex),
        Math.max(1.4, outer.distanceTo(inner) + 0.35),
      );
      return {
        a: outer.clone().addScaledVector(u, -0.35),
        b: outer.clone().addScaledVector(u, len),
        contacts: lats,
      };
    };

    if (Math.abs(lat1 - lat2) < 0.5) {
      // Tangent
      const lat = (lat1 + lat2) / 2;
      if (Math.abs(lat) < 1) return cylinder(Math.cos(lat * DEG), [lat]);
      const s = Math.sin(lat * DEG);
      return frustum(new V2(0, 1 / s), [new V2(Math.cos(lat * DEG), s)], [lat]);
    }

    // Secant: line through the two contact points, apex where it hits the axis
    const A = new V2(Math.cos(lat1 * DEG), Math.sin(lat1 * DEG));
    const B = new V2(Math.cos(lat2 * DEG), Math.sin(lat2 * DEG));
    if (Math.abs(A.x - B.x) < 1e-3) return cylinder(A.x, [lat1, lat2]); // ±φ
    const t = -A.x / (B.x - A.x);
    return frustum(new V2(0, A.y + t * (B.y - A.y)), [A, B], [lat1, lat2]);
  }

  /** Surface of revolution around y from profile point a to b, plus wireframe. */
  function revolve(a: THREE.Vector2, b: THREE.Vector2): THREE.Object3D[] {
    const mesh = new THREE.Mesh(
      new THREE.LatheGeometry([a, b], 64),
      surfaceMaterial(),
    );
    const at = (p: THREE.Vector2, t: number) =>
      new V3(p.x * Math.cos(t), p.y, p.x * Math.sin(t));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * 2 * Math.PI;
      pts.push(at(a, t), at(b, t));
    }
    for (const p of [a, b]) {
      for (let i = 0; i < 64; i++) {
        pts.push(
          at(p, (i / 64) * 2 * Math.PI),
          at(p, ((i + 1) / 64) * 2 * Math.PI),
        );
      }
    }
    return [mesh, segments(pts, 0x1d4ed8, 0.45)];
  }

  function parallelCircle(lat: number) {
    const r = Math.cos(lat * DEG);
    const y = Math.sin(lat * DEG);
    return polyline(
      arc(
        (t) =>
          new V3(
            r * Math.cos(t * 2 * Math.PI),
            y,
            r * Math.sin(t * 2 * Math.PI),
          ),
        96,
      ),
      CONTACT,
      1,
      true,
    );
  }

  /** The central meridian (lon 0) of the fixed surface frame. */
  const centralMeridian = () =>
    polyline(
      arc((t) => lonLat(0, -90 + 180 * t), 48),
      CONTACT,
      1,
    );

  // tangent plane, with projectors for perspective projections
  /**
   * `stretch` > 1 widens the plane into an ellipse: the pseudoazimuthal
   * projections (Aitoff, Hammer, Winkel Tripel, ...) are an azimuthal
   * projection stretched sideways. Schematic: the exact ratio varies.
   */
  function buildPlane(
    perspective?: ProjectionPerspective,
    clip?: number,
    stretch = 1,
  ) {
    const clipDeg = perspective ? (clip ?? DEFAULT_CLIP[perspective]) : 0;
    // Angle actually drawn: the clip angle, unless that would be off-screen.
    const thetaMax = perspective
      ? Math.min(clipDeg, thetaForRadius(perspective, MAX_PLANE_R))
      : 0;
    const R = perspective
      ? radiusAt(perspective, thetaMax)
      : stretch !== 1
        ? 1.1 // stretched sideways, so keep the half-width on screen
        : 1.6;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(R, 64),
      surfaceMaterial(),
    );
    disc.position.z = 1;

    const grid: THREE.Vector3[] = [];
    for (let k = 1; k <= 4; k++) {
      const r = (R * k) / 4;
      for (let i = 0; i < 64; i++) {
        const t0 = (i / 64) * 2 * Math.PI;
        const t1 = ((i + 1) / 64) * 2 * Math.PI;
        grid.push(
          new V3(r * Math.cos(t0), r * Math.sin(t0), 1),
          new V3(r * Math.cos(t1), r * Math.sin(t1), 1),
        );
      }
    }
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * 2 * Math.PI;
      grid.push(new V3(0, 0, 1), new V3(R * Math.cos(t), R * Math.sin(t), 1));
    }

    // Everything that stretches lives in one group, so the contact dot stays round.
    const plane = new THREE.Group();
    plane.scale.x = stretch;
    plane.add(disc, segments(grid, 0x1d4ed8, 0.4));
    if (stretch !== 1) {
      // Scale is true along the equator and the central meridian.
      plane.add(
        segments(
          [
            new V3(-R, 0, 1),
            new V3(R, 0, 1),
            new V3(0, -R, 1),
            new V3(0, R, 1),
          ],
          CONTACT,
          1,
        ),
      );
    }
    surfaceGroup.add(plane, dot(new V3(0, 0, 1), 0.04, CONTACT));

    if (!perspective) return stretch !== 1 ? 6.2 : 5.4; // not a perspective projection

    // Clip boundary on the sphere: a small circle at angle `clip` from the tangent point. It lives in the surface frame, like the plane.
    const c = clipDeg * DEG;
    surfaceGroup.add(
      polyline(
        arc(
          (t) =>
            new V3(
              Math.sin(c) * Math.cos(t * 2 * Math.PI),
              Math.sin(c) * Math.sin(t * 2 * Math.PI),
              Math.cos(c),
            ),
          96,
        ),
        CONTACT,
        1,
        true,
      ),
    );

    const thetas = [thetaMax / 3, (2 * thetaMax) / 3, thetaMax];
    const rays: THREE.Vector3[] = [];
    for (const theta of thetas) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const P = new V3(
          Math.sin(theta * DEG) * Math.cos(a),
          Math.sin(theta * DEG) * Math.sin(a),
          Math.cos(theta * DEG),
        );
        if (perspective === "orthographic") {
          rays.push(P, new V3(P.x, P.y, 1)); // parallel to the view axis
        } else if (perspective === "stereographic") {
          const s = 2 / (1 + P.z); // eye at (0, 0, -1)
          rays.push(new V3(0, 0, -1), new V3(P.x * s, P.y * s, 1));
        } else {
          rays.push(new V3(0, 0, 0), new V3(P.x / P.z, P.y / P.z, 1)); // eye at center
        }
      }
    }
    surfaceGroup.add(segments(rays, RAY, 0.7));
    if (perspective === "stereographic")
      surfaceGroup.add(dot(new V3(0, 0, -1), 0.045, 0x0f172a));
    if (perspective === "gnomonic")
      surfaceGroup.add(dot(new V3(0, 0, 0), 0.045, 0x0f172a));

    return Math.max(5, 3.8 + 1.5 * R); // camera distance grows with the plane
  }

  /**
   * Pseudocylindrical: parallels stay straight and parallel, but meridians
   * bend toward the poles, so no cylinder is truly developable. Schematic: an
   * equatorial cylinder with meridians bent like the sinusoidal projection
   * (θ = λ·cos φ), true along the equator and the central meridian.
   */
  function buildPseudocylinder() {
    const half = 1.15;
    surfaceGroup.add(...revolve(new V2(1, -half), new V2(1, half)));

    const ring = (y: number, color: number, opacity: number) =>
      polyline(
        arc(
          (t) =>
            new V3(Math.cos(t * 2 * Math.PI), y, Math.sin(t * 2 * Math.PI)),
          96,
        ),
        color,
        opacity,
        true,
      );
    for (const lat of [-60, -30, 30, 60]) {
      surfaceGroup.add(ring(Math.sin(lat * DEG), RAY, 0.45));
    }

    for (let lon = -180; lon <= 180; lon += 30) {
      if (lon === 0) continue;
      surfaceGroup.add(
        polyline(
          arc((t) => {
            const phi = (-90 + 180 * t) * DEG;
            const theta = lon * DEG * Math.cos(phi); // from +z, toward +x
            return new V3(Math.sin(theta), Math.sin(phi), Math.cos(theta));
          }, 48),
          RAY,
          0.85,
        ),
      );
    }

    surfaceGroup.add(ring(0, CONTACT, 1));
    surfaceGroup.add(
      polyline([new V3(0, -half, 1), new V3(0, half, 1)], CONTACT, 1),
    );
    return 5.6;
  }

  /** Reference lines for families that have no single developable surface. */
  function buildReferenceLines() {
    surfaceGroup.add(parallelCircle(0), centralMeridian());
    return 4.6;
  }

  /**
   * Outlines of the regions a projection with cuts maps separately. WebGL
   * lines are always 1px wide, so these are thin tubes in a dark violet that
   * stands out against the pale globe and the orange / blue guides.
   */
  const CELL = 0x6d28d9;
  const CELL_RADIUS = 0.018;
  const CELL_MAX_POINTS = 160;

  function addCells(rings: number[][][]) {
    for (const ring of rings) {
      // Rings are closed (last point repeats the first); thin out dense ones.
      const open = ring.slice(0, -1);
      const step = Math.max(1, Math.ceil(open.length / CELL_MAX_POINTS));
      const pts = open
        .filter((_, i) => i % step === 0)
        .map(([lon, lat]) => lonLat(lon, lat).multiplyScalar(1.01));
      if (pts.length < 3) continue;
      const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
      surfaceGroup.add(
        new THREE.Mesh(
          new THREE.TubeGeometry(curve, pts.length * 2, CELL_RADIUS, 6, true),
          new THREE.MeshBasicMaterial({ color: CELL }),
        ),
      );
    }
  }

  // build / update
  function frame(distance: number) {
    camera.position.set(0.55, 0.4, 0.73).normalize().multiplyScalar(distance);
    camera.lookAt(0, 0, 0);
  }

  function rebuild(
    family: ProjectionFamily,
    lat1: number,
    lat2: number,
    perspective?: ProjectionPerspective,
    clip?: number,
    cells: number[][][] = [],
  ) {
    clearGroup(surfaceGroup);
    const zAxis = family === "planar" || family === "pseudoazimuthal";
    const axisEnd = zAxis ? new V3(0, 0, 1.7) : new V3(0, 1.7, 0);
    surfaceGroup.add(
      segments([axisEnd.clone().negate(), axisEnd], CONTACT, 0.5),
    );

    if (family === "cylindrical" || family === "conic") {
      const d = developable(lat1, lat2);
      surfaceGroup.add(...revolve(d.a, d.b));
      for (const lat of d.contacts) surfaceGroup.add(parallelCircle(lat));
      frame(5.6);
    } else if (family === "planar") {
      frame(buildPlane(perspective, clip));
    } else if (family === "pseudoazimuthal") {
      frame(buildPlane(undefined, undefined, PSEUDO_STRETCH));
    } else if (family === "pseudocylindrical") {
      frame(buildPseudocylinder());
    } else {
      // "interrupted" and "other": the cells below say what is special
      frame(buildReferenceLines());
    }

    addCells(cells);
    render();
  }

  buildGlobe();

  $effect(() => {
    rebuild(
      family,
      standardParallels[0] ?? 0,
      standardParallels[1] ?? 0,
      perspective,
      clipAngle,
      cells,
    );
  });

  const euler = new THREE.Euler(0, 0, 0, "ZXY");

  // d3's rotation is applied to the sphere: M = Rz(γ+roll) · Rx(-φ) · Ry(λ).
  // The globe stays pole-up; the surface gets M⁻¹ so it sits where the projection surface really is relative to the globe.
  function surfaceQuaternion(
    [lambda, phi, gamma]: [number, number, number],
    roll: boolean,
  ) {
    euler.set(-phi * DEG, lambda * DEG, (gamma + (roll ? 90 : 0)) * DEG, "ZXY");
    return new THREE.Quaternion().setFromEuler(euler).invert();
  }

  $effect(() => {
    surfaceGroup.quaternion.copy(surfaceQuaternion(rotation, transverse));
    render();
  });

  const aspect = $derived.by(() => {
    // Angle between the globe's polar axis and the surface's axis
    // (cone/cylinder: its axis; plane: its normal / tangent point).
    const zAxis = family === "planar" || family === "pseudoazimuthal";
    const local = zAxis ? new V3(0, 0, 1) : new V3(0, 1, 0);
    const axis = local.applyQuaternion(surfaceQuaternion(rotation, transverse));
    const a = Math.acos(Math.min(1, Math.abs(axis.y))) / DEG;

    if (zAxis) {
      return a < 1 ? "polar" : a > 89 ? "equatorial" : "oblique";
    }
    return a < 1 ? "normal" : a > 89 ? "transverse" : "oblique";
  });

  const label = $derived.by(() => {
    const [p1, p2] = [standardParallels[0] ?? 0, standardParallels[1] ?? 0];
    const kind =
      Math.abs(p1 - p2) >= 0.5 || Math.abs(p1) >= 1 ? "secant" : "tangent";

    switch (family) {
      case "planar":
        return `${aspect} ${perspective ? `plane · ${perspective}` : "tangent plane"}`;
      case "cylindrical":
        return `${aspect} ${kind} cylinder`;
      case "conic":
        return `${aspect} ${kind} cone`;
      case "pseudoazimuthal":
        return `${aspect} pseudoazimuthal`;
      case "pseudocylindrical":
        return `${aspect} pseudocylindrical`;
      case "interrupted":
        return `interrupted · ${cells.length} lobes`;
      default:
        return cells.length
          ? `${cells.length} cells`
          : "equator · central meridian";
    }
  });

  onMount(() => {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(160, 160);
    container.appendChild(renderer.domElement);
    render();

    return () => {
      renderer?.dispose();
      renderer?.domElement.remove();
      renderer = undefined;
      clearGroup(earthGroup);
      clearGroup(surfaceGroup);
    };
  });
</script>

<div class="inset-wrapper" bind:this={container}>
  <div class="inset-label">{label}</div>
</div>

<style>
  .inset-wrapper {
    position: absolute;
    top: 1rem;
    right: 1rem;
    width: 12rem;
    height: 12rem;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(4px);
    border: 1px solid #cbd5e1;
    border-radius: var(--size-lg);
    overflow: hidden;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
    pointer-events: none;
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .inset-label {
    position: absolute;
    bottom: var(--size-sm);
    font-size: var(--text-3xs);
    font-weight: var(--text-bold);
    letter-spacing: 0.03em;
    text-transform: uppercase;
    background: var(--color-bg);
    padding: var(--size-xs) var(--size-sm);
    border-radius: var(--size-sm);
    border: 1px solid var(--color-edge);
  }
</style>
