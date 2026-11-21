import type {
  MapRenderer,
  MultiLayerMeshBuffers,
  RenderUniforms,
} from "./types";
import {
  DEFAULT_MAP_COLORS,
  TISSOT_ALPHA,
  hexToRgb,
  type MapColors,
} from "./map_color";
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  CELL_W,
  CELL_H,
  MAX_MARKERS,
  buildLabelAtlas,
} from "./atlas_marker";

type RGBA = [number, number, number, number];

const SAMPLES = 4;
const DOT_RADIUS = 8; // CSS px
const LABEL_SIZE = [CELL_W / 2, CELL_H / 2];
const LABEL_OFFSET = [DOT_RADIUS + 6, -LABEL_SIZE[1] / 2];

// Both shaders share this transform (same math as the WebGL vertex shader).
const common = /* wgsl */ `
struct Globals {
  viewport: vec2<f32>,
  pan: vec2<f32>,
  zoom: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> g: Globals;

fn toScreen(p: vec2<f32>) -> vec2<f32> {
  let c = g.viewport * 0.5;
  return (p - c) * g.zoom + c + g.pan;
}
fn toClip(s: vec2<f32>) -> vec4<f32> {
  let ndc = s / (g.viewport * 0.5) - vec2<f32>(1.0, 1.0);
  return vec4<f32>(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

const layerShader = /* wgsl */ `
${common}
@group(1) @binding(0) var<uniform> color: vec4<f32>;

@vertex
fn vs(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
  return toClip(toScreen(position));
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return color;
}
`;

const markerShader = /* wgsl */ `
${common}
struct MarkerU {
  radius: f32,
  hover: i32,
  labelSize: vec2<f32>,
  labelOffset: vec2<f32>,
  atlasGrid: vec2<f32>,
};
@group(1) @binding(0) var<uniform> m: MarkerU;
@group(1) @binding(1) var atlas: texture_2d<f32>;
@group(1) @binding(2) var atlasSampler: sampler;

struct DotVO {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) @interpolate(flat) index: i32,
};

@vertex
fn vsDot(
  @location(0) corner: vec2<f32>,
  @location(1) marker: vec3<f32>,
) -> DotVO {
  var o: DotVO;
  let px = toScreen(marker.xy) + corner * m.radius;
  o.position = toClip(px);
  o.local = corner;
  o.index = i32(marker.z + 0.5);
  return o;
}

@fragment
fn fsDot(in: DotVO) -> @location(0) vec4<f32> {
  let d = length(in.local);
  let aa = fwidth(d);
  let alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  let inner = 1.0 - smoothstep(0.75 - aa, 0.75 + aa, d);
  var fill = vec3<f32>(0.94, 0.27, 0.27);
  if (in.index == m.hover) {
    fill = vec3<f32>(0.86, 0.15, 0.15);
  }
  let col = mix(vec3<f32>(0.922, 0.914, 0.894), fill, inner);
  return vec4<f32>(col * alpha, alpha); // premultiplied
}

struct LabelVO {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vsLabel(
  @location(0) corner: vec2<f32>,
  @location(1) marker: vec3<f32>,
) -> LabelVO {
  var o: LabelVO;
  let c01 = corner * 0.5 + 0.5; // y = 0 is the top
  let px = toScreen(marker.xy) + m.labelOffset + c01 * m.labelSize;
  o.position = toClip(px);
  let i = floor(marker.z + 0.5);
  let cell = vec2<f32>(i % m.atlasGrid.x, floor(i / m.atlasGrid.x));
  o.uv = (cell + c01) / m.atlasGrid;
  return o;
}

@fragment
fn fsLabel(in: LabelVO) -> @location(0) vec4<f32> {
  return textureSample(atlas, atlasSampler, in.uv); // premultiplied
}
`;

interface Layer {
  pipeline: GPURenderPipeline;
  colorBuf: GPUBuffer;
  bindGroup: GPUBindGroup;
  indexed: boolean;
  vb: GPUBuffer | null;
  ib: GPUBuffer | null;
  count: number;
  color: RGBA;
}

export function createWebGpuRenderer(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
): MapRenderer {
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) throw new Error("WebGPU canvas context is not available.");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  // Shared bind group 0: viewport / pan / zoom
  const globalsBuf = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const globalsLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });
  const globalsBG = device.createBindGroup({
    layout: globalsLayout,
    entries: [{ binding: 0, resource: { buffer: globalsBuf } }],
  });

  // Pipelines
  const layerModule = device.createShaderModule({ code: layerShader });
  const markerModule = device.createShaderModule({ code: markerShader });

  const colorLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });
  const layerPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [globalsLayout, colorLayout],
  });

  const markerLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "float" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
    ],
  });
  const markerPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [globalsLayout, markerLayout],
  });

  const alphaBlend: GPUBlendState = {
    color: {
      srcFactor: "src-alpha",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
    alpha: {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
  };
  const premulBlend: GPUBlendState = {
    color: {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
    alpha: {
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha",
      operation: "add",
    },
  };

  const positionBuffer: GPUVertexBufferLayout = {
    arrayStride: 8,
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
  };

  const makeLayerPipeline = (
    topology: GPUPrimitiveTopology,
    blend?: GPUBlendState,
  ) =>
    device.createRenderPipeline({
      layout: layerPipelineLayout,
      vertex: {
        module: layerModule,
        entryPoint: "vs",
        buffers: [positionBuffer],
      },
      fragment: {
        module: layerModule,
        entryPoint: "fs",
        targets: [{ format, blend }],
      },
      primitive: { topology },
      multisample: { count: SAMPLES },
    });

  const markerBuffers: GPUVertexBufferLayout[] = [
    {
      arrayStride: 8,
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
    },
    {
      arrayStride: 12,
      stepMode: "instance",
      attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }],
    },
  ];
  const makeMarkerPipeline = (vs: string, fs: string) =>
    device.createRenderPipeline({
      layout: markerPipelineLayout,
      vertex: { module: markerModule, entryPoint: vs, buffers: markerBuffers },
      fragment: {
        module: markerModule,
        entryPoint: fs,
        targets: [{ format, blend: premulBlend }],
      },
      primitive: { topology: "triangle-strip" },
      multisample: { count: SAMPLES },
    });

  const pipelines = {
    lines: makeLayerPipeline("line-list"),
    tris: makeLayerPipeline("triangle-list"),
    trisBlend: makeLayerPipeline("triangle-list", alphaBlend),
  };
  const labelPipeline = makeMarkerPipeline("vsLabel", "fsLabel");
  const dotPipeline = makeMarkerPipeline("vsDot", "fsDot");

  // Layers
  const makeLayer = (
    pipeline: GPURenderPipeline,
    indexed: boolean,
    color: RGBA,
  ): Layer => {
    const colorBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(colorBuf, 0, new Float32Array(color));
    return {
      pipeline,
      colorBuf,
      bindGroup: device.createBindGroup({
        layout: colorLayout,
        entries: [{ binding: 0, resource: { buffer: colorBuf } }],
      }),
      indexed,
      vb: null,
      ib: null,
      count: 0,
      color,
    };
  };

  const BLANK: RGBA = [0, 0, 0, 1];
  const graticule = makeLayer(pipelines.lines, false, BLANK);
  const fill = makeLayer(pipelines.tris, true, BLANK);
  const tissot = makeLayer(pipelines.trisBlend, true, BLANK);
  const border = makeLayer(pipelines.lines, false, BLANK);
  const geoLine = makeLayer(pipelines.lines, false, BLANK);
  const measurePoly = makeLayer(
    pipelines.trisBlend,
    true,
    [0.97, 0.44, 0.44, 0.25],
  );
  const measureLine = makeLayer(pipelines.lines, false, [0.97, 0.44, 0.44, 1]);

  // Draw order (back to front), same as the WebGL renderer
  const layers = [
    graticule,
    fill,
    tissot,
    border,
    geoLine,
    measurePoly,
    measureLine,
  ];

  let clear: RGBA = BLANK;
  let geoLinesVisible = true;
  const rgba = (hex: string, a = 1): RGBA => [...hexToRgb(hex), a];

  function setLayerColor(layer: Layer, color: RGBA) {
    layer.color = color;
    device.queue.writeBuffer(layer.colorBuf, 0, new Float32Array(color));
  }

  function applyColors(c: MapColors) {
    setLayerColor(fill, rgba(c.land));
    setLayerColor(border, rgba(c.border));
    setLayerColor(graticule, rgba(c.graticule));
    setLayerColor(geoLine, rgba(c.geoLines));
    setLayerColor(tissot, rgba(c.tissot, TISSOT_ALPHA));
    clear = rgba(c.background);
  }
  applyColors(DEFAULT_MAP_COLORS);

  function makeBuffer(data: Float32Array | Uint32Array, usage: number) {
    const buf = device.createBuffer({
      size: Math.max(4, data.byteLength),
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, data);
    return buf;
  }

  function upload(
    layer: Layer,
    vertices: Float32Array,
    indices: Uint32Array | null,
  ) {
    layer.vb?.destroy();
    layer.ib?.destroy();
    layer.vb = null;
    layer.ib = null;
    layer.count = 0;

    if (vertices.length === 0) return;
    if (layer.indexed) {
      if (!indices || indices.length === 0) return;
      layer.ib = makeBuffer(indices, GPUBufferUsage.INDEX);
      layer.count = indices.length;
    } else {
      layer.count = vertices.length / 2;
    }
    layer.vb = makeBuffer(vertices, GPUBufferUsage.VERTEX);
  }

  // Markers
  const cornerBuf = makeBuffer(
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), // triangle strip
    GPUBufferUsage.VERTEX,
  );
  const markerBuf = device.createBuffer({
    size: MAX_MARKERS * 12,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  let markerCount = 0;
  let hoveredMarker = -1;

  // radius, hover, labelSize(2), labelOffset(2), atlasGrid(2) = 32 bytes
  const markerData = new ArrayBuffer(32);
  const markerF32 = new Float32Array(markerData);
  const markerI32 = new Int32Array(markerData);
  markerF32.set([DOT_RADIUS], 0);
  markerF32.set(LABEL_SIZE, 2);
  markerF32.set(LABEL_OFFSET, 4);
  markerF32.set([ATLAS_COLS, ATLAS_ROWS], 6);
  const markerUniformBuf = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const atlasSource = buildLabelAtlas();
  const atlasTex = device.createTexture({
    size: [atlasSource.width, atlasSource.height],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT, // required by copyExternalImageToTexture
  });
  device.queue.copyExternalImageToTexture(
    { source: atlasSource },
    { texture: atlasTex, premultipliedAlpha: true },
    [atlasSource.width, atlasSource.height],
  );
  const atlasSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const markerBG = device.createBindGroup({
    layout: markerLayout,
    entries: [
      { binding: 0, resource: { buffer: markerUniformBuf } },
      { binding: 1, resource: atlasTex.createView() },
      { binding: 2, resource: atlasSampler },
    ],
  });

  // MSAA target, recreated whenever the canvas size changes
  let msaaTex: GPUTexture | null = null;
  function ensureMsaa(w: number, h: number) {
    if (msaaTex && msaaTex.width === w && msaaTex.height === h) return;
    msaaTex?.destroy();
    msaaTex = device.createTexture({
      size: [w, h],
      sampleCount: SAMPLES,
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  function drawLayer(pass: GPURenderPassEncoder, layer: Layer) {
    if (layer.count === 0 || !layer.vb) return;
    pass.setPipeline(layer.pipeline);
    pass.setBindGroup(1, layer.bindGroup);
    pass.setVertexBuffer(0, layer.vb);
    if (layer.indexed && layer.ib) {
      pass.setIndexBuffer(layer.ib, "uint32");
      pass.drawIndexed(layer.count);
    } else {
      pass.draw(layer.count);
    }
  }

  function drawMarkers(pass: GPURenderPassEncoder) {
    if (markerCount === 0) return;
    pass.setBindGroup(1, markerBG);
    pass.setVertexBuffer(0, cornerBuf);
    pass.setVertexBuffer(1, markerBuf);

    pass.setPipeline(labelPipeline);
    pass.draw(4, markerCount);

    pass.setPipeline(dotPipeline); // dots on top
    pass.draw(4, markerCount);
  }

  return {
    backend: "webgpu",

    updateGeometry(b: MultiLayerMeshBuffers) {
      upload(fill, b.fillVertices, b.fillIndices);
      upload(border, b.borderVertices, null);
      upload(graticule, b.graticuleVertices, null);
      upload(geoLine, b.geoLineVertices, null);
      upload(tissot, b.tissotVertices, b.tissotIndices);
    },

    updateMeasurements(
      lineVertices: Float32Array,
      polyVertices: Float32Array,
      polyIndices: Uint32Array,
    ) {
      upload(measureLine, lineVertices, null);
      upload(measurePoly, polyVertices, polyIndices);
    },

    updateMarkers(data: Float32Array) {
      // data = [x, y, pointIndex, ...] in projected px
      const n = Math.min(Math.floor(data.length / 3), MAX_MARKERS);
      if (n > 0) device.queue.writeBuffer(markerBuf, 0, data, 0, n * 3);
      markerCount = n;
    },

    setColors: applyColors,

    setGeoLinesVisible(visible: boolean) {
      geoLinesVisible = visible;
    },

    setHoveredMarker(index: number) {
      hoveredMarker = index;
    },

    render(u: RenderUniforms) {
      const w = canvas.width;
      const h = canvas.height;
      if (w === 0 || h === 0) return;
      ensureMsaa(w, h);

      device.queue.writeBuffer(
        globalsBuf,
        0,
        new Float32Array([
          u.viewport[0],
          u.viewport[1],
          u.pan[0],
          u.pan[1],
          u.zoom,
          0,
          0,
          0,
        ]),
      );
      markerI32[1] = hoveredMarker;
      device.queue.writeBuffer(markerUniformBuf, 0, markerData);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: msaaTex!.createView(),
            resolveTarget: context.getCurrentTexture().createView(),
            clearValue: {
              r: clear[0],
              g: clear[1],
              b: clear[2],
              a: clear[3],
            },
            loadOp: "clear",
            storeOp: "discard", // only the resolved texture is needed
          },
        ],
      });

      pass.setBindGroup(0, globalsBG);
      for (const layer of layers) {
        if (layer === geoLine && !geoLinesVisible) continue;
        drawLayer(pass, layer);
      }
      drawMarkers(pass);

      pass.end();
      device.queue.submit([encoder.finish()]);
    },

    resize() {
      // Canvas size is handled upstream; the MSAA target follows it in render()
    },

    destroy() {
      for (const l of layers) {
        l.vb?.destroy();
        l.ib?.destroy();
        l.colorBuf.destroy();
      }
      cornerBuf.destroy();
      markerBuf.destroy();
      markerUniformBuf.destroy();
      globalsBuf.destroy();
      atlasTex.destroy();
      msaaTex?.destroy();
      context.unconfigure();
    },
  };
}
