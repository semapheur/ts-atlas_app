export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 16; // 128 labels max
export const CELL_W = 64; // device px (2x supersampled: 32x16 CSS px)
export const CELL_H = 32;
export const MAX_MARKERS = ATLAS_COLS * ATLAS_ROWS;

export function buildLabelAtlas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = ATLAS_COLS * CELL_W;
  c.height = ATLAS_ROWS * CELL_H;
  const ctx = c.getContext("2d")!;
  ctx.font = "600 20px system-ui, sans-serif";
  ctx.textBaseline = "middle";

  for (let i = 0; i < MAX_MARKERS; i++) {
    const x = (i % ATLAS_COLS) * CELL_W;
    const y = Math.floor(i / ATLAS_COLS) * CELL_H;
    const text = `#${i + 1}`;
    const w = Math.min(CELL_W, Math.ceil(ctx.measureText(text).width) + 16);

    ctx.fillStyle = "#33373c";
    ctx.beginPath();
    ctx.roundRect(x, y + 2, w, CELL_H - 4, 8);
    ctx.fill();
    ctx.strokeStyle = "#4a4f56";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#ebe9e4";
    ctx.fillText(text, x + 8, y + CELL_H / 2 + 1);
  }
  return c;
}
