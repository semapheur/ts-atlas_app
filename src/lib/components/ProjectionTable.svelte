<script lang="ts">
  import type { ProjectionFamily, ProjectionMeta } from "../projections";

  interface Props {
    projections: readonly ProjectionMeta[];
    selectedId: string;
    familyLabels: Record<ProjectionFamily, string>;
    onselect: (id: string) => void;
  }

  let { projections, selectedId, familyLabels, onselect }: Props = $props();

  type SortKey = "name" | "family" | "category" | "description";
  const COLUMNS: { key: SortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "family", label: "Family" },
    { key: "category", label: "Category" },
    { key: "description", label: "Description" },
  ];

  let dialog: HTMLDialogElement;

  /** Opens the dialog (call through bind:this). */
  export function open() {
    if (!dialog.open) dialog.showModal();
  }
  export function close() {
    dialog.close();
  }

  // filters and sorting
  let nameFilter = $state("");
  let descriptionFilter = $state("");
  let familyFilter = $state(""); // "" = all
  let categoryFilter = $state("");
  let sort = $state<{ key: SortKey; dir: "asc" | "desc" } | null>(null);

  const familyOf = (p: ProjectionMeta) => familyLabels[p.family] ?? p.family;
  const valueOf = (p: ProjectionMeta, key: SortKey): string =>
    key === "family" ? familyOf(p) : p[key];

  const familyOptions = $derived(
    [...new Set(projections.map(familyOf))].sort((a, b) => a.localeCompare(b)),
  );
  const categoryOptions = $derived(
    [...new Set(projections.map((p) => p.category))].sort((a, b) =>
      a.localeCompare(b),
    ),
  );

  const collator = new Intl.Collator(undefined, {
    sensitivity: "base",
    numeric: true,
  });

  const rows = $derived.by(() => {
    const name = nameFilter.trim().toLowerCase();
    const description = descriptionFilter.trim().toLowerCase();

    const filtered = projections.filter(
      (p) =>
        (!name || p.name.toLowerCase().includes(name)) &&
        (!description || p.description.toLowerCase().includes(description)) &&
        (!familyFilter || familyOf(p) === familyFilter) &&
        (!categoryFilter || p.category === categoryFilter),
    );

    if (!sort) return filtered;
    const { key, dir } = sort;
    const sign = dir === "asc" ? 1 : -1;
    // Array.prototype.sort is stable, so ties keep registry order
    return [...filtered].sort(
      (a, b) => sign * collator.compare(valueOf(a, key), valueOf(b, key)),
    );
  });

  const filtersActive = $derived(
    !!(nameFilter || descriptionFilter || familyFilter || categoryFilter),
  );

  function clearFilters() {
    nameFilter = descriptionFilter = familyFilter = categoryFilter = "";
  }

  /** none -> ascending -> descending -> none */
  function toggleSort(key: SortKey) {
    if (sort?.key !== key) sort = { key, dir: "asc" };
    else if (sort.dir === "asc") sort = { key, dir: "desc" };
    else sort = null;
  }

  const ariaSort = (key: SortKey) =>
    sort?.key !== key
      ? "none"
      : sort.dir === "asc"
        ? "ascending"
        : "descending";

  function apply(id: string) {
    onselect(id);
    dialog.close();
  }

  // Clicks on the backdrop land on the <dialog> element itself.
  function onBackdropClick(e: MouseEvent) {
    if (e.target === dialog) dialog.close();
  }
</script>

<dialog
  bind:this={dialog}
  class="projection-table-dialog"
  aria-labelledby="projection-table-title"
  onclick={onBackdropClick}
>
  <div class="shell">
    <header>
      <h2 id="projection-table-title">All projections</h2>
      <span class="count" aria-live="polite">
        {rows.length} of {projections.length}
      </span>
      <button
        type="button"
        class="ghost"
        onclick={clearFilters}
        disabled={!filtersActive}
      >
        Clear filters
      </button>
      <button
        type="button"
        class="ghost close"
        onclick={close}
        aria-label="Close"
      >
        ✕
      </button>
    </header>

    <div class="scroller">
      <table>
        <colgroup>
          <col class="c-name" />
          <col class="c-family" />
          <col class="c-category" />
          <col />
          <col class="c-apply" />
        </colgroup>
        <thead>
          <tr class="labels">
            {#each COLUMNS as col (col.key)}
              <th scope="col" aria-sort={ariaSort(col.key)}>
                <button
                  type="button"
                  class="sort"
                  onclick={() => toggleSort(col.key)}
                >
                  {col.label}
                  <span class="arrow" aria-hidden="true">
                    {sort?.key === col.key
                      ? sort.dir === "asc"
                        ? "▲"
                        : "▼"
                      : "↕"}
                  </span>
                </button>
              </th>
            {/each}
            <th scope="col" class="apply-head">Apply</th>
          </tr>
          <tr class="filters">
            <th>
              <input
                type="search"
                placeholder="Filter name…"
                aria-label="Filter by name"
                bind:value={nameFilter}
              />
            </th>
            <th>
              <select aria-label="Filter by family" bind:value={familyFilter}>
                <option value="">All</option>
                {#each familyOptions as f (f)}
                  <option value={f}>{f}</option>
                {/each}
              </select>
            </th>
            <th>
              <select
                aria-label="Filter by category"
                bind:value={categoryFilter}
              >
                <option value="">All</option>
                {#each categoryOptions as c (c)}
                  <option value={c}>{c}</option>
                {/each}
              </select>
            </th>
            <th>
              <input
                type="search"
                placeholder="Filter description…"
                aria-label="Filter by description"
                bind:value={descriptionFilter}
              />
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as p (p.id)}
            <tr class:current={p.id === selectedId}>
              <td class="name">{p.name}</td>
              <td>{familyOf(p)}</td>
              <td>
                <span class="cat {p.category.toLowerCase()}">{p.category}</span>
              </td>
              <td class="desc">{p.description}</td>
              <td class="apply-cell">
                <button
                  type="button"
                  class="apply"
                  disabled={p.id === selectedId}
                  onclick={() => apply(p.id)}
                >
                  {p.id === selectedId ? "Current" : "Apply"}
                </button>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="5" class="empty">
                No projections match these filters.
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</dialog>

<style>
  dialog {
    --bg: #2a2d32;
    --panel: #33373c;
    --line: #4a4f56;
    --ink: #ebe9e4;
    --muted: #a6a9af;
    --accent: #61a5fa;

    padding: 0;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--bg);
    color: var(--ink);
    width: min(1100px, 94vw);
    height: min(80vh, 780px);
    box-shadow: 0 20px 60px rgb(0 0 0 / 0.5);
  }
  dialog[open] {
    display: flex;
  }
  dialog::backdrop {
    background: rgb(10 12 15 / 0.6);
  }

  .shell {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-height: 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
    flex: 1;
  }
  .count {
    color: var(--muted);
    font-size: 0.85rem;
  }

  .scroller {
    overflow: auto;
    min-height: 0;
    flex: 1;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 0.875rem;
  }
  .c-name {
    width: 21%;
  }
  .c-family {
    width: 15%;
  }
  .c-category {
    width: 12%;
  }
  .c-apply {
    width: 92px;
  }

  thead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--panel);
  }
  th {
    text-align: left;
    font-weight: 600;
    padding: 0.4rem 0.6rem;
  }
  .labels th {
    padding-bottom: 0.1rem;
  }
  .filters th {
    padding-top: 0.1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--line);
  }
  .apply-head {
    text-align: center;
  }

  td {
    padding: 0.5rem 0.6rem;
    vertical-align: top;
    border-bottom: 1px solid rgb(255 255 255 / 0.06);
  }
  td.name {
    font-weight: 600;
  }
  td.desc {
    color: #cfd0d3;
    line-height: 1.35;
  }
  .apply-cell {
    text-align: center;
  }
  tbody tr:hover {
    background: rgb(255 255 255 / 0.04);
  }
  tr.current {
    background: rgb(97 165 250 / 0.12);
  }
  .empty {
    text-align: center;
    color: var(--muted);
    padding: 2rem;
  }

  input,
  select,
  button {
    font: inherit;
    color: inherit;
  }
  input,
  select {
    width: 100%;
    box-sizing: border-box;
    padding: 0.3rem 0.45rem;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 5px;
  }
  input:focus-visible,
  select:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  button {
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .sort {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0;
    background: none;
    border: none;
    font-weight: 600;
  }
  .arrow {
    color: var(--muted);
    font-size: 0.7rem;
  }
  th[aria-sort="ascending"] .arrow,
  th[aria-sort="descending"] .arrow {
    color: var(--accent);
  }

  .ghost {
    padding: 0.3rem 0.65rem;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 5px;
  }
  .ghost:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.06);
  }
  .close {
    padding: 0.3rem 0.5rem;
  }

  .apply {
    padding: 0.3rem 0.7rem;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 5px;
  }
  .apply:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .cat {
    display: inline-block;
    padding: 0.05rem 0.45rem;
    border-radius: 4px;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    background: #3a3f46;
  }
  .cat.conformal {
    background: #1e3a5f;
    color: #bcdcff;
  }
  .cat.equal-area {
    background: #1d4d38;
    color: #c3f2d6;
  }
  .cat.compromise {
    background: #5a4318;
    color: #fde3a6;
  }
  .cat.equidistant {
    background: #46285f;
    color: #e3c8ff;
  }
</style>
