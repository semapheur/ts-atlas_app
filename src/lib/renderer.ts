import { createWebGpuRenderer } from "./webgpu";
import { createWebGlRenderer } from "./webgl";
import type { MapRenderer } from "./types";

export async function createRenderer(
  canvas: HTMLCanvasElement,
): Promise<MapRenderer> {
  if (typeof navigator !== "undefined" && "gpu" in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const device = await adapter.requestDevice();
        return createWebGpuRenderer(canvas, device);
      }
    } catch (e) {
      console.log("yay");
      (console.warn("WebGPU initialization failed, falling back to WebGL2:"),
        e);
    }
  }

  return createWebGlRenderer(canvas);
}
