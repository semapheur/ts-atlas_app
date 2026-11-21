import {
  ATLAS_COLS,
  ATLAS_ROWS,
  buildLabelAtlas,
  CELL_H,
  CELL_W,
  MAX_MARKERS,
} from "./atlas_marker";
import {
  DEFAULT_MAP_COLORS,
  hexToRgb,
  TISSOT_ALPHA,
  type MapColors,
} from "./map_color";
import type {
  MapRenderer,
  MultiLayerMeshBuffers,
  RenderUniforms,
} from "./types";

type RGBA = [number, number, number, number];

interface ProgramInfo {
  program: WebGLProgram;
  aPosition: number;
  uViewport: WebGLUniformLocation | null;
  uPan: WebGLUniformLocation | null;
  uZoom: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

interface Layer {
  prog: ProgramInfo;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer | null; // null => drawArrays
  mode: number; // gl.LINES | gl.TRIANGLES
  blend: boolean;
  count: number;
  color: RGBA;
}

const vsSource = `#version 300 es
in vec2 a_position;
uniform vec2 u_viewport;
uniform vec2 u_pan;
uniform float u_zoom;

void main() {
  vec2 center = u_viewport * 0.5;
  vec2 scaled = (a_position - center) * u_zoom + center + u_pan;
  vec2 ndc = (scaled / center) - vec2(1.0, 1.0);
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

const fsColorSource = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  fragColor = u_color;
}
`;

// Both marker shaders share one VAO, so attribute locations are fixed.
const markerCornerAttrs = `
layout(location = 0) in vec2 a_corner;  // -1..1 quad corner
layout(location = 1) in vec3 a_marker;  // x, y (projected px), point index
`;

const markerCommon = `
uniform vec2 u_viewport;
uniform vec2 u_pan;
uniform float u_zoom;

vec2 toScreen(vec2 projected) {
  vec2 center = u_viewport * 0.5;
  return (projected - center) * u_zoom + center + u_pan;
}
vec4 toClip(vec2 screenPx) {
  vec2 ndc = screenPx / (u_viewport * 0.5) - 1.0;
  return vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

const vsDotSource = `#version 300 es
${markerCornerAttrs}
${markerCommon}
uniform float u_radius;
out vec2 v_local;
flat out int v_index;
void main() {
  vec2 px = toScreen(a_marker.xy) + a_corner * u_radius;
  gl_Position = toClip(px);
  v_local = a_corner;
  v_index = int(a_marker.z + 0.5);
}
`;

const fsDotSource = `#version 300 es
precision highp float;
in vec2 v_local;
flat in int v_index;
uniform int u_hover;
out vec4 fragColor;
void main() {
  float d = length(v_local);               // 0..1 in units of the radius
  float aa = fwidth(d);
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  float inner = 1.0 - smoothstep(0.75 - aa, 0.75 + aa, d); // 2px border of 8px
  vec3 fill = (v_index == u_hover) ? vec3(0.86, 0.15, 0.15) : vec3(0.94, 0.27, 0.27);
  vec3 color = mix(vec3(1.0), fill, inner);
  fragColor = vec4(color * alpha, alpha);  // premultiplied
}
`;

const vsLabelSource = `#version 300 es
${markerCornerAttrs}
${markerCommon}
uniform vec2 u_labelSize;     // CSS px
uniform vec2 u_labelOffset;   // CSS px from the vertex to the label's top-left
uniform vec2 u_atlasGrid;     // columns, rows
out vec2 v_uv;
void main() {
  vec2 c01 = a_corner * 0.5 + 0.5;         // 0..1, y=0 is the top
  vec2 px = toScreen(a_marker.xy) + u_labelOffset + c01 * u_labelSize;
  gl_Position = toClip(px);
  float i = floor(a_marker.z + 0.5);
  vec2 cell = vec2(mod(i, u_atlasGrid.x), floor(i / u_atlasGrid.x));
  v_uv = (cell + c01) / u_atlasGrid;
}
`;

const fsLabelSource = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_atlas;
out vec4 fragColor;
void main() {
  fragColor = texture(u_atlas, v_uv);      // premultiplied
}
`;

function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile error: ${info}`);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string,
) {
  const program = gl.createProgram()!;
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program link error: ${info}`);
  }
  return program;
}

function createProgramInfo(gl: WebGL2RenderingContext): ProgramInfo {
  const program = createProgram(gl, vsSource, fsColorSource);
  return {
    program,
    aPosition: gl.getAttribLocation(program, "a_position"),
    uViewport: gl.getUniformLocation(program, "u_viewport"),
    uPan: gl.getUniformLocation(program, "u_pan"),
    uZoom: gl.getUniformLocation(program, "u_zoom"),
    uColor: gl.getUniformLocation(program, "u_color"),
  };
}

export function createWebGlRenderer(canvas: HTMLCanvasElement): MapRenderer {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: true });
  if (!gl) throw new Error("WebGL2 is not supported in this environment.");

  const makeLayer = (
    color: RGBA,
    mode: number,
    opts: { indexed?: boolean; blend?: boolean } = {},
  ): Layer => ({
    prog: createProgramInfo(gl),
    vao: gl.createVertexArray()!,
    vbo: gl.createBuffer()!,
    ibo: opts.indexed ? gl.createBuffer()! : null,
    mode,
    blend: !!opts.blend,
    count: 0,
    color,
  });

  const BLANK: RGBA = [0, 0, 0, 1];
  let geoLinesVisible = true;
  const graticule = makeLayer(BLANK, gl.LINES);
  const fill = makeLayer(BLANK, gl.TRIANGLES, { indexed: true });
  const tissot = makeLayer(BLANK, gl.TRIANGLES, {
    indexed: true,
    blend: true,
  });
  const border = makeLayer(BLANK, gl.LINES);
  const geoLine = makeLayer(BLANK, gl.LINES);
  const measurePoly = makeLayer([0.97, 0.44, 0.44, 0.25], gl.TRIANGLES, {
    indexed: true,
    blend: true,
  });
  const measureLine = makeLayer([0.97, 0.44, 0.44, 0.25], gl.LINES);

  let clear: RGBA = BLANK;
  const rgba = (hex: string, a = 1): RGBA => [...hexToRgb(hex), a];

  function applyColors(c: MapColors) {
    fill.color = rgba(c.land);
    border.color = rgba(c.border);
    graticule.color = rgba(c.graticule);
    geoLine.color = rgba(c.geoLines);
    tissot.color = rgba(c.tissot, TISSOT_ALPHA);
    clear = rgba(c.background);
  }
  applyColors(DEFAULT_MAP_COLORS);

  // Draw order (back to front)
  const layers = [
    graticule,
    fill,
    tissot,
    border,
    geoLine,
    measurePoly,
    measureLine,
  ];

  // Markers
  const DOT_RADIUS = 8; // CSS px (16px dot incl. 2px border)
  const LABEL_SIZE: [number, number] = [CELL_W / 2, CELL_H / 2];
  const LABEL_OFFSET: [number, number] = [DOT_RADIUS + 6, -LABEL_SIZE[1] / 2];

  const dotProg = createProgram(gl, vsDotSource, fsDotSource);
  const labelProg = createProgram(gl, vsLabelSource, fsLabelSource);

  const loc = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
  const dotU = {
    viewport: loc(dotProg, "u_viewport"),
    pan: loc(dotProg, "u_pan"),
    zoom: loc(dotProg, "u_zoom"),
    radius: loc(dotProg, "u_radius"),
    hover: loc(dotProg, "u_hover"),
  };
  const labelU = {
    viewport: loc(labelProg, "u_viewport"),
    pan: loc(labelProg, "u_pan"),
    zoom: loc(labelProg, "u_zoom"),
    size: loc(labelProg, "u_labelSize"),
    offset: loc(labelProg, "u_labelOffset"),
    grid: loc(labelProg, "u_atlasGrid"),
    atlas: loc(labelProg, "u_atlas"),
  };

  const markerVao = gl.createVertexArray()!;
  const cornerBuf = gl.createBuffer()!;
  const markerBuf = gl.createBuffer()!;
  let markerCount = 0;
  let hoveredMarker = -1;

  gl.bindVertexArray(markerVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), // triangle strip
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, markerBuf);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0);
  gl.vertexAttribDivisor(1, 1); // one (x, y, index) per instance
  gl.bindVertexArray(null);

  const atlasTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    buildLabelAtlas(),
  );
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function drawMarkers(u: RenderUniforms) {
    if (markerCount === 0) return;

    gl!.enable(gl!.BLEND);
    gl!.blendFunc(gl!.ONE, gl!.ONE_MINUS_SRC_ALPHA); // premultiplied
    gl!.bindVertexArray(markerVao);

    // Labels
    gl!.useProgram(labelProg);
    gl!.uniform2f(labelU.viewport, u.viewport[0], u.viewport[1]);
    gl!.uniform2f(labelU.pan, u.pan[0], u.pan[1]);
    gl!.uniform1f(labelU.zoom, u.zoom);
    gl!.uniform2f(labelU.size, LABEL_SIZE[0], LABEL_SIZE[1]);
    gl!.uniform2f(labelU.offset, LABEL_OFFSET[0], LABEL_OFFSET[1]);
    gl!.uniform2f(labelU.grid, ATLAS_COLS, ATLAS_ROWS);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, atlasTex);
    gl!.uniform1i(labelU.atlas, 0);
    gl!.drawArraysInstanced(gl!.TRIANGLE_STRIP, 0, 4, markerCount);

    // Dots (on top)
    gl!.useProgram(dotProg);
    gl!.uniform2f(dotU.viewport, u.viewport[0], u.viewport[1]);
    gl!.uniform2f(dotU.pan, u.pan[0], u.pan[1]);
    gl!.uniform1f(dotU.zoom, u.zoom);
    gl!.uniform1f(dotU.radius, DOT_RADIUS);
    gl!.uniform1i(dotU.hover, hoveredMarker);
    gl!.drawArraysInstanced(gl!.TRIANGLE_STRIP, 0, 4, markerCount);

    gl!.disable(gl!.BLEND);
  }

  function upload(
    layer: Layer,
    vertices: Float32Array,
    indices: Uint32Array | null,
    usage: number,
  ) {
    gl!.bindVertexArray(layer.vao);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, layer.vbo);
    gl!.bufferData(gl!.ARRAY_BUFFER, vertices, usage);
    gl!.enableVertexAttribArray(layer.prog.aPosition);
    gl!.vertexAttribPointer(layer.prog.aPosition, 2, gl!.FLOAT, false, 8, 0);

    if (layer.ibo && indices) {
      gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, layer.ibo);
      gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, indices, usage);
      layer.count = indices.length;
    } else {
      layer.count = vertices.length / 2;
    }
    gl!.bindVertexArray(null);
  }

  function drawLayer(layer: Layer, u: RenderUniforms) {
    if (layer.count === 0) return;
    const { prog } = layer;

    gl!.useProgram(prog.program);
    gl!.uniform2f(prog.uViewport, u.viewport[0], u.viewport[1]);
    gl!.uniform2f(prog.uPan, u.pan[0], u.pan[1]);
    gl!.uniform1f(prog.uZoom, u.zoom);
    gl!.uniform4f(prog.uColor, ...layer.color);

    if (layer.blend) {
      gl!.enable(gl!.BLEND);
      gl!.blendFunc(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA);
    }

    gl!.bindVertexArray(layer.vao);
    if (layer.ibo) {
      gl!.drawElements(layer.mode, layer.count, gl!.UNSIGNED_INT, 0);
    } else {
      gl!.drawArrays(layer.mode, 0, layer.count);
    }

    if (layer.blend) gl!.disable(gl!.BLEND);
  }

  return {
    backend: "webgl2",

    updateGeometry(b: MultiLayerMeshBuffers) {
      upload(fill, b.fillVertices, b.fillIndices, gl.STATIC_DRAW);
      upload(border, b.borderVertices, null, gl.STATIC_DRAW);
      upload(graticule, b.graticuleVertices, null, gl.STATIC_DRAW);
      upload(geoLine, b.geoLineVertices, null, gl.STATIC_DRAW);
      upload(tissot, b.tissotVertices, b.tissotIndices, gl.STATIC_DRAW);
    },

    updateMeasurements(
      lineVertices: Float32Array,
      polyVertices: Float32Array,
      polyIndices: Uint32Array,
    ) {
      upload(measureLine, lineVertices, null, gl.DYNAMIC_DRAW);

      if (polyVertices.length > 0 && polyIndices.length > 0) {
        upload(measurePoly, polyVertices, polyIndices, gl.DYNAMIC_DRAW);
      } else {
        measurePoly.count = 0;
      }
    },

    updateMarkers(data: Float32Array) {
      // data = [x, y, pointIndex, x, y, pointIndex, ...] in projected px
      const n = Math.min(data.length / 3, MAX_MARKERS);
      gl.bindBuffer(gl.ARRAY_BUFFER, markerBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 3), gl.DYNAMIC_DRAW);
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
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.98, 0.98, 0.99, 1.0);
      gl.clearColor(...clear);
      gl.clear(gl.COLOR_BUFFER_BIT);

      for (const layer of layers) {
        if (layer === geoLine && !geoLinesVisible) continue;
        drawLayer(layer, u);
      }
      drawMarkers(u);

      gl.bindVertexArray(null);
    },

    resize() {
      // Handled upstream by container and canvas width/height bindings
    },

    destroy() {
      for (const l of layers) {
        gl.deleteBuffer(l.vbo);
        if (l.ibo) gl.deleteBuffer(l.ibo);
        gl.deleteVertexArray(l.vao);
        gl.deleteProgram(l.prog.program);
      }

      gl.deleteBuffer(cornerBuf);
      gl.deleteBuffer(markerBuf);
      gl.deleteVertexArray(markerVao);
      gl.deleteTexture(atlasTex);
      gl.deleteProgram(dotProg);
      gl.deleteProgram(labelProg);
    },
  };
}
