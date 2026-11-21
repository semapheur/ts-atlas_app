<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    checked: boolean;
    children: Snippet;
  }

  let { checked = $bindable(), children }: Props = $props();
</script>

<label>
  <input type="checkbox" bind:checked />
  {@render children()}
</label>

<style>
  label {
    font-size: var(--text-sm);
  }
</style>
