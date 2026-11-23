<script lang="ts">
  import { onMount, untrack } from "svelte";
  import earcut from "earcut";
  import {
    geoArea,
    geoDistance,
    geoGraticule10,
    geoInterpolate,
    type GeoProjection,
  } from "d3-geo";
  import Button from "./Button.svelte";
  import { tessellateGeoLayers } from "../tessellate";
  import { createRenderer } from "../renderer";
  import type { GeoData, MapRenderer, MeasureMode } from "../types";
  import {
    fitProjection,
    initialRotation,
    type ProjectionMeta,
  } from "../projections";
  import { buildSvg } from "../export_svg";
  import type { MapColors } from "../map_color";

  type XY = [number, number];

  interface Props {
    data: GeoData;
    projection: GeoProjection;
    meta: ProjectionMeta;
    showTissot: boolean;
    showGeoLines: boolean;
    rotation: [number, number, number];
    measureMode: MeasureMode;
    colors: MapColors;
    exporter?: { png: (scale?: number) => void; svg: () => void } | null;
  }

  let {
    data,
    projection,
    meta,
    showTissot,
    showGeoLines,
    rotation = $bindable(),
    measureMode,
    colors,
    exporter = $bindable(null),
  }: Props = $props();

  let canvas: HTMLCanvasElement;
  let renderer = $state<MapRenderer | null>(null);
  let width = $state(800);
  let height = $state(500);
  let zoom = $state(1);
  let pan = $state<[number, number]>([0, 0]);
  let dpr = $state(1);

  let cursor = $state<{ x: number; y: number } | null>(null);
  const cursorGeo = $derived(cursor ? screenToGeo(cursor.x, cursor.y) : null);

  let isDragging = $state(false);
  let startX = 0;
  let startY = 0;
  let pendingDx = 0;
  let pendingDy = 0;
  let dragFrame = 0;

  const MARKER_HIT_RADIUS = 10; // CSS px
  const EDGE_HIT_RADIUS = 8;
  const DOUBLE_CLICK_MS = 350;
  const DOUBLE_CLICK_PX = 6;
  let areaClosed = $state(false);
  let dragVertex = $state(-1);
  let hoverEdge = $state(false);
  let lastAdd: { t: number; x: number; y: number } | null = null;

  let measureKind = $state<"distance" | "area" | null>(null);
  let measuredPoints = $state<[number, number][]>([]);

  const graticule = geoGraticule10();
  const EARTH_RADIUS_KM = 6371;
  const RAD2DEG = 180 / Math.PI;

  let hovered = $state(-1);

  let view = $derived.by(() => {
    fitProjection(meta, projection, rotation, width, height);
    return { projection };
  });

  let canvasCursor = $derived.by(() => {
    if (dragVertex >= 0 || isDragging) return "grabbing";
    if (measureMode !== "none") {
      if (hovered >= 0) return "grab";
      if (hoverEdge) return "copy";
      return "crosshair";
    }
    return "grab";
  });

  /** Projects a point, or returns null if it is clipped or not finite. */
  function project(p: GeoProjection, pt: XY): XY | null {
    // clipAngle() returns 0 when the projection uses antimeridian clipping.
    const clip = p.clipAngle();
    if (clip !== null && clip > 0) {
      // The view center in geographic coordinates is the negated rotation.
      const [lambda, phi] = p.rotate();
      if (geoDistance(pt, [-lambda, -phi]) * RAD2DEG > clip) return null;
    }
    const q = p(pt);
    return q && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null;
  }

  let screenPoints = $derived.by(() => {
    const p = view.projection;
    const cx = width / 2;
    const cy = height / 2;
    const out: {
      x: number;
      y: number;
      lon: number;
      lat: number;
      index: number;
    }[] = [];
    for (let i = 0; i < measuredPoints.length; i++) {
      const pt = measuredPoints[i];
      const proj = project(p, pt);
      if (!proj) continue;
      // Mirrors the vertex shader: (pos - center) * zoom + center + pan
      out.push({
        x: (proj[0] - cx) * zoom + cx + pan[0],
        y: (proj[1] - cy) * zoom + cy + pan[1],
        lon: pt[0],
        lat: pt[1],
        index: i,
      });
    }
    return out;
  });

  let measurementResult = $derived.by(() => {
    if (measureKind === "distance" && measuredPoints.length === 2) {
      const [p1, p2] = measuredPoints;
      const trueKm = geoDistance(p1, p2) * EARTH_RADIUS_KM;
      const a = view.projection(p1);
      const b = view.projection(p2);
      const projPx = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
      return `True Great-Circle Distance: ${trueKm.toFixed(1)} km (${projPx.toFixed(0)} projected px)`;
    }

    if (measureKind === "area" && areaClosed && measuredPoints.length >= 3) {
      const polygon = {
        type: "Polygon" as const,
        coordinates: [[...measuredPoints, measuredPoints[0]]],
      };
      // d3 is winding-order sensitive: the wrong order yields 4π - A.
      // Always report the smaller of the two regions.
      const raw = geoArea(polygon);
      const steradians = raw > 2 * Math.PI ? 4 * Math.PI - raw : raw;
      const km2 = steradians * EARTH_RADIUS_KM ** 2;
      return `True Spherical Area: ${km2.toLocaleString(undefined, { maximumFractionDigits: 0 })} km²`;
    }

    return null;
  });

  function draw() {
    renderer?.render({ viewport: [width, height], pan, zoom });
  }

  function clearMeasurements() {
    measuredPoints = [];
    areaClosed = false;
    dragVertex = -1;
  }

  function removePoint(index: number) {
    measuredPoints = measuredPoints.filter((_, i) => i !== index);
    if (measuredPoints.length < 3) areaClosed = false;
  }

  function formatCoord([lon, lat]: [number, number]) {
    const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
    const ns = lat >= 0 ? "N" : "S";
    const ew = wrapped >= 0 ? "E" : "W";
    return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(wrapped).toFixed(2)}° ${ew}`;
  }

  function sampleArc(p: GeoProjection, a: XY, b: XY): (XY | null)[] {
    const degrees = (geoDistance(a, b) * 180) / Math.PI;
    const steps = Math.min(512, Math.max(1, Math.ceil(degrees)));
    const interp = geoInterpolate(a, b);

    const out: (XY | null)[] = [];
    for (let i = 0; i <= steps; i++) {
      out.push(project(p, interp(i / steps)));
    }
    return out;
  }

  onMount(() => {
    let active = true;

    Promise.resolve(createRenderer(canvas))
      .then((r) => {
        if (active) renderer = r;
        else r.destroy();
      })
      .catch((err) => console.error("Failed to create renderer:", err));

    // Non-passive so preventDefault() reliably blocks page scroll
    canvas.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      active = false;
      canvas.removeEventListener("wheel", handleWheel);
      cancelAnimationFrame(dragFrame);
      renderer?.destroy();
    };
  });

  // Switching between distance and area starts fresh. Switching to Pan/Rotate keeps the measurement on screen.
  $effect(() => {
    const mode = measureMode;
    untrack(() => {
      if (mode === "none") {
        hovered = -1;
        hoverEdge = false;
        dragVertex = -1;
        return;
      }
      if (mode !== measureKind) clearMeasurements();
      measureKind = mode;
    });
  });

  // Re-project and tessellate whenever projection, rotation, or geometry changes
  $effect(() => {
    if (!renderer) return;

    const buffers = tessellateGeoLayers({
      countries: data.countries,
      graticule,
      geographicLines: data.geographicLines,
      projection: view.projection,
      interruption: meta.interruption,
      showTissot,
    });
    renderer.updateGeometry(buffers);
    untrack(draw);
  });

  // Rebuild measurement overlay geometry (also runs when projection changes)
  $effect(() => {
    if (!renderer?.updateMeasurements) return;

    const p = view.projection;
    const mode = measureKind;
    // Consecutive samples are ~1° apart, so a jump this large in projected
    // space means the arc crossed the antimeridian / an interruption.
    const jumpLimit = 0.35 * Math.min(width, height);

    const lineVerts: number[] = [];
    const ring: number[] = [];
    let ringOk = true;

    const n = measuredPoints.length;
    const closed = mode === "area" && areaClosed && n >= 3;
    const segCount = closed ? n : n - 1;

    for (let i = 0; i < segCount; i++) {
      const samples = sampleArc(
        p,
        measuredPoints[i],
        measuredPoints[(i + 1) % n],
      );

      for (let j = 0; j < samples.length; j++) {
        const cur = samples[j];
        if (!cur) {
          ringOk = false;
          continue;
        }

        // The last sample is the next segment's first; skip it to avoid dupes
        if (j < samples.length - 1) ring.push(cur[0], cur[1]);

        const prev = j > 0 ? samples[j - 1] : null;
        if (!prev) continue;

        if (Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) <= jumpLimit) {
          lineVerts.push(prev[0], prev[1], cur[0], cur[1]);
        } else {
          ringOk = false; // broke the line here
        }
      }
    }

    // Only fill when the whole boundary is visible and continuous; otherwise earcut would triangulate across the break.
    let polyVerts = new Float32Array(0);
    let polyIndices = new Uint32Array(0);
    if (closed && ringOk && ring.length >= 6) {
      polyVerts = new Float32Array(ring);
      polyIndices = new Uint32Array(earcut(ring, undefined, 2));
    }

    // Always upload, even when empty, so cleared measurements disappear
    renderer.updateMeasurements(
      new Float32Array(lineVerts),
      polyVerts,
      polyIndices,
    );
    untrack(draw);
  });

  // Cheap redraw for pan / zoom / resize / DPR changes
  $effect(() => {
    void dpr;
    draw();
  });

  // Upload marker positions (projected space, same as the lines)
  $effect(() => {
    if (!renderer?.updateMarkers) return;
    const p = view.projection;
    const out: number[] = [];
    if (measureMode !== null) {
      measuredPoints.forEach((pt, i) => {
        const q = project(p, pt);
        if (q) {
          out.push(q[0], q[1], i);
        }
      });
    }
    renderer.updateMarkers(new Float32Array(out));
    untrack(draw);
  });

  $effect(() => {
    renderer?.setColors?.(colors);
    untrack(draw);
  });

  $effect(() => {
    renderer?.setHoveredMarker?.(measureMode === "none" ? -1 : hovered);
    untrack(draw);
  });

  $effect(() => {
    renderer?.setGeoLinesVisible?.(showGeoLines);
    untrack(draw);
  });

  // Convert screen click to spherical [lon, lat] via projection.invert()
  function screenToGeo(
    clientX: number,
    clientY: number,
  ): [number, number] | null {
    const p = view.projection;
    if (!p.invert) return null;

    const rect = canvas.getBoundingClientRect();
    const screenX = (clientX - rect.left) * (width / rect.width);
    const screenY = (clientY - rect.top) * (height / rect.height);

    // Reverse shader transformation: ndc -> screen -> projection space
    const projX = (screenX - width / 2 - pan[0]) / zoom + width / 2;
    const projY = (screenY - height / 2 - pan[1]) / zoom + height / 2;

    const coords = p.invert([projX, projY]);
    if (!coords || Number.isNaN(coords[0]) || Number.isNaN(coords[1]))
      return null;

    // Reject clicks outside the projected sphere (invert can extrapolate)
    const back = p(coords);
    if (!back || Math.hypot(back[0] - projX, back[1] - projY) > 1) return null;

    if (!project(p, coords)) return null;

    // Outside the clip extent (conic conformal)
    const extent = p.clipExtent();
    if (
      extent &&
      (projX < extent[0][0] ||
        projX > extent[1][0] ||
        projY < extent[0][1] ||
        projY > extent[1][1])
    ) {
      return null;
    }

    return coords;
  }

  function markerAt(clientX: number, clientY: number): number {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (width / rect.width);
    const y = (clientY - rect.top) * (height / rect.height);

    let best = -1;
    let bestDist = MARKER_HIT_RADIUS;
    for (const pt of screenPoints) {
      const d = Math.hypot(pt.x - x, pt.y - y);
      if (d <= bestDist) {
        bestDist = d;
        best = pt.index; // later (top-most) markers win ties
      }
    }
    return best;
  }

  function toCanvasXY(clientX: number, clientY: number): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return [
      (clientX - rect.left) * (width / rect.width),
      (clientY - rect.top) * (height / rect.height),
    ];
  }

  function distToSegment(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Index of the edge (i → i+1) under the cursor, or -1. Tests the sampled great-circle arcs, not straight chords, so it matches what is drawn.
  function edgeAt(clientX: number, clientY: number): number {
    const n = measuredPoints.length;
    if (!areaClosed || n < 3) return -1;

    const p = view.projection;
    const [x, y] = toCanvasXY(clientX, clientY);
    const cx = width / 2;
    const cy = height / 2;
    const jumpLimit = 0.35 * Math.min(width, height); // projected px, as in the draw effect
    const toScreen = (q: [number, number]): [number, number] => [
      (q[0] - cx) * zoom + cx + pan[0],
      (q[1] - cy) * zoom + cy + pan[1],
    ];

    let best = -1;
    let bestDist = EDGE_HIT_RADIUS;
    for (let i = 0; i < n; i++) {
      const s = sampleArc(p, measuredPoints[i], measuredPoints[(i + 1) % n]);
      for (let j = 1; j < s.length; j++) {
        const a = s[j - 1];
        const b = s[j];
        if (!a || !b) continue;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > jumpLimit) continue;
        const [ax, ay] = toScreen(a);
        const [bx, by] = toScreen(b);
        const d = distToSegment(x, y, ax, ay, bx, by);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
    return best;
  }

  function handlePointerDown(e: PointerEvent) {
    if (measureMode !== "none") {
      // Double-click closes the area. Must run before the marker hit test: the second click lands on the marker the first click just created.
      if (
        measureMode === "area" &&
        !areaClosed &&
        measuredPoints.length >= 3 &&
        lastAdd &&
        e.timeStamp - lastAdd.t < DOUBLE_CLICK_MS &&
        Math.hypot(e.clientX - lastAdd.x, e.clientY - lastAdd.y) <
          DOUBLE_CLICK_PX
      ) {
        areaClosed = true;
        lastAdd = null;
        return;
      }

      const hit = markerAt(e.clientX, e.clientY);
      if (hit >= 0) {
        if (e.altKey) {
          removePoint(hit);
          hovered = -1;
        } else {
          dragVertex = hit;
          canvas.setPointerCapture(e.pointerId);
        }
        return;
      }

      // Closed polygon: pressing on an edge inserts a vertex and drags it
      if (areaClosed) {
        const edge = edgeAt(e.clientX, e.clientY);
        const geo = edge >= 0 ? screenToGeo(e.clientX, e.clientY) : null;
        if (geo) {
          measuredPoints = [
            ...measuredPoints.slice(0, edge + 1),
            geo,
            ...measuredPoints.slice(edge + 1),
          ];
          dragVertex = edge + 1;
          canvas.setPointerCapture(e.pointerId);
        }
        return;
      }

      const geoCoord = screenToGeo(e.clientX, e.clientY);
      if (!geoCoord) return;

      if (measureMode === "distance") {
        measuredPoints =
          measuredPoints.length >= 2
            ? [geoCoord]
            : [...measuredPoints, geoCoord];
      } else {
        measuredPoints = [...measuredPoints, geoCoord];
        lastAdd = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      }
      return;
    }

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    cursor = { x: e.clientX, y: e.clientY };
    if (measureMode !== "none") {
      if (dragVertex >= 0) {
        const geo = screenToGeo(e.clientX, e.clientY);
        if (geo) {
          const i = dragVertex;
          measuredPoints = measuredPoints.map((pt, k) => (k === i ? geo : pt));
        }
        return;
      }
      hovered = markerAt(e.clientX, e.clientY);
      hoverEdge = hovered < 0 && edgeAt(e.clientX, e.clientY) >= 0;
      return;
    }
    if (!isDragging) return;

    const rect = canvas.getBoundingClientRect();

    pendingDx += (e.clientX - startX) * (width / rect.width);
    pendingDy += (e.clientY - startY) * (height / rect.height);

    startX = e.clientX;
    startY = e.clientY;

    if (dragFrame) return;

    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;

      const sensitivity = 0.4 / zoom;
      const [lambda, phi, gamma] = rotation;

      rotation = [
        lambda + pendingDx * sensitivity,
        Math.max(-85, Math.min(85, phi - pendingDy * sensitivity)),
        gamma,
      ];

      pendingDx = 0;
      pendingDy = 0;
    });
  }

  function endDrag(e: PointerEvent) {
    dragVertex = -1;
    isDragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left) * (width / rect.width);
    const mouseY = (e.clientY - rect.top) * (height / rect.height);

    const oldZoom = zoom;
    const newZoom = Math.max(
      0.5,
      Math.min(10, oldZoom * Math.exp(-e.deltaY * 0.002)),
    );
    const ratio = newZoom / oldZoom;

    // Keep the point under the cursor stationary
    pan = [
      mouseX - width / 2 - (mouseX - width / 2 - pan[0]) * ratio,
      mouseY - height / 2 - (mouseY - height / 2 - pan[1]) * ratio,
    ];
    zoom = newZoom;
  }

  function resetView() {
    zoom = 1;
    pan = [0, 0];
    rotation = initialRotation(meta);
    clearMeasurements();
  }

  function download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportPng(scale = 4) {
    if (!renderer) return;

    // Resize, render and capture in the same task: the drawing buffer isn't preserved.
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    draw();
    canvas.toBlob((blob) => {
      if (blob) download(blob, `${meta.id}-map.png`);
    }, "image/png");

    // toBlob has already snapshotted the bitmap, so it's safe to restore.
    canvas.width = width;
    canvas.height = height;
    draw();
  }

  function exportSvg() {
    const svg = buildSvg({
      data,
      graticule,
      projection: view.projection,
      interruption: meta.interruption,
      width,
      height,
      zoom,
      pan,
      showTissot,
      showGeoLines,
      measureKind,
      points: measuredPoints,
      areaClosed,
      markers: screenPoints,
      colors,
    });
    download(new Blob([svg], { type: "image/svg+xml" }), `${meta.id}-map.svg`);
  }
  exporter = { png: exportPng, svg: exportSvg };
</script>

<div
  class="map-container"
  bind:clientWidth={width}
  bind:clientHeight={height}
  style:background={colors.background}
>
  <canvas
    bind:this={canvas}
    {width}
    {height}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={endDrag}
    onpointerleave={() => {
      hovered = -1;
      hoverEdge = false;
      cursor = null;
    }}
    onwheel={handleWheel}
    style:cursor={canvasCursor}
  ></canvas>

  {#if measurementResult}
    <div class="measurement-banner">
      {measurementResult}
      <button onclick={clearMeasurements}> Clear </button>
    </div>
  {/if}

  <div class="controls-overlay">
    <Button onclick={resetView}>Reset View</Button>
    <div class="coord-readout">
      {cursorGeo ? formatCoord(cursorGeo) : "—"}
    </div>
  </div>
</div>

<style>
  .map-container {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    cursor: grab;
  }
  .map-container:active {
    cursor: grabbing;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .measurement-banner {
    position: absolute;
    top: 1.25rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--color-panel);
    color: var(--color-ink);
    padding: 0.5rem 1rem;
    border-radius: var(--size-md);
    font-size: var(--text-sm);
    font-weight: 500;
    display: flex;
    gap: 1rem;
    align-items: center;
    z-index: 25;
  }
  .measurement-banner button {
    background: var(--color-bg);
    border: none;
    color: var(--color-ink);
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--color-edge);
    border-radius: var(--size-sm);
    cursor: pointer;
    font-size: 0.75rem;
  }
  .controls-overlay {
    position: absolute;
    bottom: 1rem;
    left: 1rem;
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .coord-readout {
    min-width: 10rem;
    text-align: right;
    background: var(--color-panel);
    color: var(--color-ink);
    border: 1px solid var(--color-edge);
    border-radius: var(--size-sm);
    padding: 0.35rem 0.75rem;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
</style>
