<script lang="ts">
  interface Props {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    neutral?: number;
    unit?: string;
  }

  let {
    label,
    value = $bindable(),
    min,
    max,
    step,
    neutral,
    unit = "",
  }: Props = $props();
</script>

<label class="slider">
  <span>{label}</span>
  <input
    type="range"
    {min}
    {max}
    {step}
    bind:value
    ondblclick={() => {
      if (neutral !== undefined) value = neutral;
    }}
  />
  <output>{value.toFixed(Number.isInteger(step) ? 0 : 1)}{unit}</output>
</label>

<style>
  .slider {
    display: grid;
    grid-template-columns: 8rem minmax(0, 1fr) 3rem;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-sm);
  }
</style>
