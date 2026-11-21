<script lang="ts">
  import { type Snippet } from "svelte";
  import { type HTMLButtonAttributes } from "svelte/elements";

  interface Props extends HTMLButtonAttributes {
    children: Snippet;
    background?: string;
    active?: boolean;
  }

  let { children, background, active, ...rest }: Props = $props();
</script>

<button class:active style:background-color={background ?? undefined} {...rest}>
  {@render children()}
</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    gap: var(--size-sm);
    appearance: none;
    padding: var(--size-md);
    color: var(--color-ink);
    background-color: var(--color-bg);
    border: 1px solid var(--color-edge);
    border-radius: var(--size-sm);
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: var(--font-bold);
    line-height: var(--button-line-height);

    &.active {
      background-color: var(--color-well);
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
</style>
