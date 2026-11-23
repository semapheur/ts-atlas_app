<script lang="ts">
  import AtlasMap from "./lib/components/AtlasMap.svelte";
  import ProjectionScene from "./lib/components/ProjectionScene.svelte";
  import ProjectionTable from "./lib/components/ProjectionTable.svelte";
  import Select from "./lib/components/Select.svelte";
  import CheckBox from "./lib/components/CheckBox.svelte";
  import Slider from "./lib/components/Slider.svelte";
  import Button from "./lib/components/Button.svelte";
  import {
    PROJECTIONS,
    PROJECTION_LIST,
    defaultParams,
    initialRotation,
    type ProjectionId,
    type ParamValues,
    type ProjectionFamily,
  } from "./lib/projections";
  import { cellOutlines } from "./lib/interruption";
  import countriesPoly from "./data/ne_110m_admin_0_countries.json";
  import geographicLine from "./data/ne_110m_geographic_lines.json";
  import type { MeasureMode, GeoData } from "./lib/types";
  import { DEFAULT_MAP_COLORS, type MapColors } from "./lib/map_color";

  const data: GeoData = {
    countries: countriesPoly,
    geographicLines: geographicLine,
  };

  let projectionTable = $state<ReturnType<typeof ProjectionTable> | null>(null);
  let selectedKey = $state<ProjectionId>("orthographic");
  let rotation = $state<[number, number, number]>([0, 0, 0]);
  let showTissot = $state<boolean>(true);
  let showGeoLines = $state<boolean>(true);
  let measureMode = $state<MeasureMode>("none");
  let paramStore = $state<Partial<Record<ProjectionId, ParamValues>>>({});
  let mapColors = $state<MapColors>({ ...DEFAULT_MAP_COLORS });
  let exporter = $state<{
    png: (scale?: number) => void;
    svg: () => void;
  } | null>(null);
  let pngScale = $state(2);

  const activeMeta = $derived(PROJECTIONS[selectedKey]);
  const params = $derived<ParamValues>({
    ...defaultParams(activeMeta),
    ...paramStore[selectedKey],
  });
  const projection = $derived(activeMeta.create(params));
  const cells = $derived(cellOutlines(projection, activeMeta.interruption));
  const standardParallels = $derived(
    activeMeta.parallelsFor?.(params) ?? activeMeta.standardParallels,
  );

  const hint = $derived(
    measureMode === "distance"
      ? "💡 Click two points to measure. Click a marker to move it."
      : measureMode === "area"
        ? "💡 Click to add points, double-click to close. Then drag vertices, drag an edge to add one, Alt+click a vertex to delete."
        : "💡 Drag to rotate, scroll to zoom.",
  );

  const COLOR_FIELDS: { key: keyof MapColors; label: string }[] = [
    { key: "background", label: "Background" },
    { key: "land", label: "Country fill" },
    { key: "border", label: "Country borders" },
    { key: "graticule", label: "Graticule" },
    { key: "geoLines", label: "Geographic lines" },
    { key: "tissot", label: "Tissot circles" },
  ];

  const FAMILY_LABELS: Record<ProjectionFamily, string> = {
    planar: "Azimuthal (planar)",
    cylindrical: "Cylindrical",
    pseudocylindrical: "Pseudocylindrical",
    pseudoazimuthal: "Pseudoazimuthal",
    conic: "Conic",
    interrupted: "Interrupted",
    other: "Other",
  };
  const selectGroups = (Object.keys(FAMILY_LABELS) as ProjectionFamily[])
    .map((family) => ({
      label: FAMILY_LABELS[family],
      options: PROJECTION_LIST.filter((p) => p.family === family).map((p) => ({
        value: p.id,
        label: p.name,
      })),
    }))
    .filter((g) => g.options.length > 0);

  $effect(() => {
    rotation = initialRotation(activeMeta);
  });

  function setParam(id: string, value: number) {
    paramStore[selectedKey] = { ...params, [id]: value };
  }
  function resetParams() {
    delete paramStore[selectedKey];
  }
</script>

<main class="app-layout">
  <aside class="sidebar">
    <header>
      <h1>Map Projections</h1>
    </header>

    <div class="info-card">
      <span class="category-tag {activeMeta.category.toLowerCase()}">
        {activeMeta.category}
      </span>
      <p>{activeMeta.description}</p>
    </div>

    <section class="selector-group">
      <Select
        bind:value={selectedKey}
        label="Select projection"
        groups={selectGroups}
      />
      <Button class="control-button" onclick={() => projectionTable?.open()}>
        Browse all projections…
      </Button>
    </section>

    <div class="control-group">
      <CheckBox bind:checked={showTissot}>
        Show Tissot's indicatrix (distortion circles)
      </CheckBox>
      <CheckBox bind:checked={showGeoLines}>Show geographic lines</CheckBox>
    </div>

    {#if activeMeta.params?.length}
      <section class="control-section">
        <h2>Parameters</h2>

        {#each activeMeta.params as p (p.id)}
          <Slider
            label={p.label}
            bind:value={() => params[p.id], (v) => setParam(p.id, v)}
            min={p.min}
            max={p.max}
            step={p.step}
            neutral={p.default}
            unit={p.unit}
          />
        {/each}
        <Button class="control-button" onclick={resetParams}>
          Reset parameters
        </Button>
      </section>
    {/if}

    <section class="control-section">
      <h2>Measurement Tools</h2>
      <Button
        class="control-button"
        active={measureMode === "none"}
        onclick={() => (measureMode = "none")}
      >
        Pan / Rotate
      </Button>
      <Button
        class="control-button"
        active={measureMode === "distance"}
        onclick={() => (measureMode = "distance")}
      >
        Measure Distance
      </Button>
      <Button
        class="control-button"
        active={measureMode === "area"}
        onclick={() => (measureMode = "area")}
      >
        Measure Area
      </Button>
    </section>

    <section class="control-section">
      <h2>Export</h2>
      <div class="button-group">
        <Button
          class="control-button"
          disabled={!exporter}
          onclick={() => exporter?.png(pngScale)}
        >
          PNG
        </Button>
        <Button
          class="control-button"
          disabled={!exporter}
          onclick={() => exporter?.svg()}
        >
          SVG
        </Button>
      </div>
      <Select label="PNG scale" bind:value={pngScale} options={[1, 2, 3, 4]} />
    </section>

    <section class="control-section">
      <details>
        <summary>Colors</summary>
        {#each COLOR_FIELDS as f (f.key)}
          <label class="color-row">
            <span>{f.label}</span>
            <input type="color" bind:value={mapColors[f.key]} />
          </label>
        {/each}
        <Button
          class="control-button"
          onclick={() => (mapColors = { ...DEFAULT_MAP_COLORS })}
        >
          Reset colors
        </Button>
      </details>
    </section>

    <div class="hint">
      <small>{hint}</small>
    </div>
  </aside>

  <section class="canvas-pane">
    <AtlasMap
      {data}
      {projection}
      meta={activeMeta}
      {showTissot}
      {showGeoLines}
      {measureMode}
      colors={mapColors}
      bind:rotation
      bind:exporter
    />
    <ProjectionScene
      {rotation}
      family={activeMeta.family}
      form={activeMeta.form}
      {standardParallels}
      clipAngle={params.clip}
      perspective={activeMeta.perspective}
      transverse={activeMeta.transverse}
      {cells}
    />
  </section>
  <ProjectionTable
    bind:this={projectionTable}
    projections={PROJECTION_LIST}
    selectedId={selectedKey}
    familyLabels={FAMILY_LABELS}
    onselect={(id) => (selectedKey = id as ProjectionId)}
  />
</main>

<style>
  .app-layout {
    display: grid;
    grid-template-columns: 20rem 1fr;
    height: 100%;
  }
  .sidebar {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--text-lg);
    overflow-y: auto;
    scrollbar-gutter: stable;
    background: var(--color-panel);
    border-right: 1px solid var(--color-edge);
    padding: var(--size-lg);
  }
  .control-group {
    display: flex;
    flex-direction: column;
  }
  .control-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-sm);
  }
  .control-section :global(.control-button) {
    align-self: flex-start;
  }
  .selector-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-weight: var(--text-bold);
  }
  .info-card {
    display: flex;
    flex-direction: column;
    gap: var(--size-lg);
    background: var(--color-well);
    padding: 1rem;
    border-radius: var(--size-md);
    font-size: var(--text-sm);
    line-height: 1.4;
  }
  .info-card p {
    margin: 0;
  }
  .color-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--text-sm);
  }
  .color-row input[type="color"] {
    width: 2.25rem;
    height: 1.5rem;
    padding: 0;
    border: 1px solid var(--color-edge);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }
  .category-tag {
    align-self: flex-start;
    padding: 0.2rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: var(--size-sm);
    text-transform: uppercase;
  }
  .category-tag.conformal {
    background: #dbeafe;
    color: #1e40af;
  }
  .category-tag.equal-area {
    background: #dcfce7;
    color: #166534;
  }
  .category-tag.compromise {
    background: #fef3c7;
    color: #92400e;
  }
  .hint {
    margin-top: auto;
    color: var(--color-ink);
    font-style: italic;
  }
  .canvas-pane {
    position: relative;
  }
</style>
