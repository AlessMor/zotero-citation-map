import type {
  CitationGraphNode,
  GraphAxisMetric,
  GraphLayoutOptions,
} from "../domain/graphTypes";
import {
  CitationGraphRenderer,
  type GhostPreview,
} from "./citationGraphRenderer";

interface Position {
  x: number;
  y: number;
}

interface AxisScale {
  domain: [number, number];
}

interface RendererRuntime {
  canvas: HTMLCanvasElement;
  layout: GraphLayoutOptions;
  positions: Map<string, Position>;
  transform: {
    x: number;
    y: number;
    scale: number;
  };
  axisScale(nodes: CitationGraphNode[], axis: "x" | "y"): AxisScale | null;
  visibleNodes(): CitationGraphNode[];
  isDarkMode(): boolean;
}

interface RendererPrototype {
  [PATCH_MARKER]?: boolean;
  setTransientPreview?: (
    this: RendererRuntime,
    preview: GhostPreview | null,
  ) => void;
  destroy?: (this: RendererRuntime) => void;
}

interface OverlayState {
  canvas: HTMLCanvasElement;
  preview: GhostPreview | null;
  frame: number | null;
  lastSignature: string;
  parentPositionChanged: boolean;
  previousParentPosition: string;
}

const PATCH_MARKER = "__citationMapTransientGhostOverlayFix" as const;
const OVERLAY_CLASS = "citation-map-transient-overlay";
const PLOT_LEFT = 105;
const PLOT_RIGHT = 1030;
const PLOT_TOP = 60;
const PLOT_BOTTOM = 675;
const overlayByRenderer = new WeakMap<object, OverlayState>();

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function scaleValue(
  value: number,
  minimum: number,
  maximum: number,
  scale: "linear" | "log",
): number {
  if (maximum <= minimum) return 0.5;
  if (scale === "log") {
    if (value <= 0 || minimum <= 0 || maximum <= 0) return 0;
    return (
      (Math.log(value) - Math.log(minimum)) /
      (Math.log(maximum) - Math.log(minimum))
    );
  }
  return (value - minimum) / (maximum - minimum);
}

function ghostMetricNumber(
  preview: GhostPreview,
  metric: GraphAxisMetric,
): number | null {
  const value =
    metric === "year"
      ? preview.year
      : metric === "citations"
        ? preview.citationCount
        : metric === "references"
          ? preview.referenceCount
          : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function worldGhostPosition(
  renderer: RendererRuntime,
  preview: GhostPreview,
): { position: Position; sources: Position[] } {
  const sources = preview.sourceKeys
    .map((key) => renderer.positions.get(key))
    .filter((position): position is Position => Boolean(position));

  const centroidX = sources.length
    ? sources.reduce((sum, source) => sum + source.x, 0) / sources.length
    : (PLOT_LEFT + PLOT_RIGHT) / 2;
  const centroidY = sources.length
    ? sources.reduce((sum, source) => sum + source.y, 0) / sources.length
    : (PLOT_TOP + PLOT_BOTTOM) / 2;

  const seed = hash(preview.key);
  const angle = ((seed % 360) * Math.PI) / 180;
  const radius = 70 + (seed % 31);
  let x = clamp(centroidX + Math.cos(angle) * radius, PLOT_LEFT, PLOT_RIGHT);
  let y = clamp(centroidY + Math.sin(angle) * radius, PLOT_TOP, PLOT_BOTTOM);

  const nodes = renderer.visibleNodes();
  const xScale = renderer.axisScale(nodes, "x");
  const yScale = renderer.axisScale(nodes, "y");
  const xValue = ghostMetricNumber(preview, renderer.layout.xMetric);
  const yValue = ghostMetricNumber(preview, renderer.layout.yMetric);

  if (xScale && renderer.layout.xMetric !== "free" && xValue !== null) {
    x =
      renderer.layout.xScale === "log" && xValue <= 0
        ? PLOT_LEFT
        : PLOT_LEFT +
          clamp(
            scaleValue(
              xValue,
              xScale.domain[0],
              xScale.domain[1],
              renderer.layout.xScale,
            ),
            0,
            1,
          ) *
            (PLOT_RIGHT - PLOT_LEFT);
  }

  if (yScale && renderer.layout.yMetric !== "free" && yValue !== null) {
    y =
      renderer.layout.yScale === "log" && yValue <= 0
        ? PLOT_BOTTOM
        : PLOT_BOTTOM -
          clamp(
            scaleValue(
              yValue,
              yScale.domain[0],
              yScale.domain[1],
              renderer.layout.yScale,
            ),
            0,
            1,
          ) *
            (PLOT_BOTTOM - PLOT_TOP);
  }

  return { position: { x, y }, sources };
}

function ensureOverlay(renderer: RendererRuntime): OverlayState | null {
  const existing = overlayByRenderer.get(renderer as object);
  if (existing) return existing;

  const parent = renderer.canvas.parentElement;
  if (!parent) return null;

  const overlay = renderer.canvas.ownerDocument.createElement("canvas");
  overlay.className = OVERLAY_CLASS;
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "4",
  });

  const view = renderer.canvas.ownerDocument.defaultView;
  const computedPosition =
    view?.getComputedStyle(parent)?.position ?? parent.style.position;
  const parentPositionChanged =
    computedPosition === "" || computedPosition === "static";
  const previousParentPosition = parent.style.position;
  if (parentPositionChanged) parent.style.position = "relative";
  parent.appendChild(overlay);

  const state: OverlayState = {
    canvas: overlay,
    preview: null,
    frame: null,
    lastSignature: "",
    parentPositionChanged,
    previousParentPosition,
  };
  overlayByRenderer.set(renderer as object, state);
  return state;
}

function overlaySignature(
  renderer: RendererRuntime,
  preview: GhostPreview,
): string {
  const sourcePositions = preview.sourceKeys
    .map((key) => {
      const position = renderer.positions.get(key);
      return position
        ? `${key}:${position.x.toFixed(2)},${position.y.toFixed(2)}`
        : key;
    })
    .join("|");
  return [
    renderer.canvas.width,
    renderer.canvas.height,
    renderer.transform.x.toFixed(2),
    renderer.transform.y.toFixed(2),
    renderer.transform.scale.toFixed(4),
    renderer.layout.xMetric,
    renderer.layout.yMetric,
    renderer.layout.xScale,
    renderer.layout.yScale,
    preview.key,
    preview.title,
    preview.year,
    preview.citationCount,
    preview.referenceCount,
    preview.contextLabel,
    sourcePositions,
    renderer.isDarkMode(),
  ].join(";");
}

function sizeOverlay(renderer: RendererRuntime, state: OverlayState): void {
  const rect = renderer.canvas.getBoundingClientRect();
  const ratio = renderer.canvas.width / Math.max(1, rect.width);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (state.canvas.width !== width) state.canvas.width = width;
  if (state.canvas.height !== height) state.canvas.height = height;
}

function drawOverlay(
  renderer: RendererRuntime,
  state: OverlayState,
  preview: GhostPreview,
): void {
  sizeOverlay(renderer, state);
  const context = state.canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, state.canvas.width, state.canvas.height);

  const rect = renderer.canvas.getBoundingClientRect();
  const ratio = renderer.canvas.width / Math.max(1, rect.width);
  const { position: worldPosition, sources } = worldGhostPosition(
    renderer,
    preview,
  );
  const toScreen = (position: Position): Position => ({
    x: renderer.transform.x + position.x * renderer.transform.scale,
    y: renderer.transform.y + position.y * renderer.transform.scale,
  });

  const natural = toScreen(worldPosition);
  const horizontalMargin = 76 * ratio;
  const topMargin = 32 * ratio;
  const bottomMargin = 74 * ratio;
  const position = {
    x: clamp(
      natural.x,
      horizontalMargin,
      Math.max(horizontalMargin, state.canvas.width - horizontalMargin),
    ),
    y: clamp(
      natural.y,
      topMargin,
      Math.max(topMargin, state.canvas.height - bottomMargin),
    ),
  };

  const dark = renderer.isDarkMode();
  context.save();
  context.lineCap = "round";
  context.setLineDash([7 * ratio, 5 * ratio]);
  context.lineWidth = 2.4 * ratio;
  context.strokeStyle = dark
    ? "rgba(147, 197, 253, .98)"
    : "rgba(37, 99, 235, .94)";
  for (const source of sources) {
    const screenSource = toScreen(source);
    context.beginPath();
    context.moveTo(screenSource.x, screenSource.y);
    context.lineTo(position.x, position.y);
    context.stroke();
  }

  const nodeRadius = 12 * ratio;
  const haloRadius = 19 * ratio;
  context.setLineDash([]);
  context.beginPath();
  context.arc(position.x, position.y, haloRadius, 0, Math.PI * 2);
  context.lineWidth = 5 * ratio;
  context.strokeStyle = dark
    ? "rgba(15, 23, 42, .98)"
    : "rgba(255, 255, 255, .98)";
  context.stroke();

  context.beginPath();
  context.arc(position.x, position.y, haloRadius, 0, Math.PI * 2);
  context.setLineDash([5 * ratio, 3.5 * ratio]);
  context.lineWidth = 3 * ratio;
  context.strokeStyle = dark ? "rgb(147 197 253)" : "rgb(30 64 175)";
  context.stroke();

  context.setLineDash([]);
  context.beginPath();
  context.arc(position.x, position.y, nodeRadius, 0, Math.PI * 2);
  context.fillStyle = dark
    ? "rgba(71, 85, 105, .99)"
    : "rgba(203, 213, 225, .99)";
  context.fill();
  context.lineWidth = 1.5 * ratio;
  context.strokeStyle = dark ? "rgb(248 250 252)" : "rgb(15 23 42)";
  context.stroke();

  const title =
    preview.title.length > 50
      ? `${preview.title.slice(0, 47)}…`
      : preview.title;
  const titleY = position.y + 31 * ratio;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `${11 * ratio}px sans-serif`;
  context.lineWidth = 3.5 * ratio;
  context.strokeStyle = dark
    ? "rgba(15, 23, 42, .98)"
    : "rgba(255, 255, 255, .98)";
  context.strokeText(title, position.x, titleY);
  context.fillStyle = dark ? "rgb(248 250 252)" : "rgb(15 23 42)";
  context.fillText(title, position.x, titleY);

  const contextLabel = preview.contextLabel ?? "Outside current filters";
  const labelY = position.y + 47 * ratio;
  context.font = `600 ${10 * ratio}px sans-serif`;
  context.lineWidth = 3 * ratio;
  context.strokeStyle = dark
    ? "rgba(15, 23, 42, .98)"
    : "rgba(255, 255, 255, .98)";
  context.strokeText(contextLabel, position.x, labelY);
  context.fillStyle = dark ? "rgb(191 219 254)" : "rgb(30 64 175)";
  context.fillText(contextLabel, position.x, labelY);
  context.restore();
}

function scheduleOverlay(renderer: RendererRuntime, state: OverlayState): void {
  if (state.frame !== null) return;
  const view = renderer.canvas.ownerDocument.defaultView;
  if (!view) return;

  const frame = (): void => {
    state.frame = null;
    const preview = state.preview;
    if (!preview || !state.canvas.isConnected || !renderer.canvas.isConnected) {
      return;
    }
    const signature = overlaySignature(renderer, preview);
    if (signature !== state.lastSignature) {
      state.lastSignature = signature;
      drawOverlay(renderer, state, preview);
    }
    state.frame = view.requestAnimationFrame(frame);
  };
  state.frame = view.requestAnimationFrame(frame);
}

function removeOverlay(renderer: RendererRuntime): void {
  const state = overlayByRenderer.get(renderer as object);
  if (!state) return;
  const view = renderer.canvas.ownerDocument.defaultView;
  if (state.frame !== null) view?.cancelAnimationFrame(state.frame);
  const parent = state.canvas.parentElement;
  state.canvas.remove();
  if (parent && state.parentPositionChanged) {
    parent.style.position = state.previousParentPosition;
  }
  overlayByRenderer.delete(renderer as object);
}

const prototype =
  CitationGraphRenderer.prototype as unknown as RendererPrototype;
if (!prototype[PATCH_MARKER]) {
  const originalSetTransientPreview = prototype.setTransientPreview;
  const originalDestroy = prototype.destroy;

  prototype.setTransientPreview = function (
    preview: GhostPreview | null,
  ): void {
    originalSetTransientPreview?.call(this, preview);
    if (!preview) {
      removeOverlay(this);
      return;
    }
    const state = ensureOverlay(this);
    if (!state) return;
    state.preview = preview;
    state.lastSignature = "";
    drawOverlay(this, state, preview);
    scheduleOverlay(this, state);
  };

  prototype.destroy = function (): void {
    removeOverlay(this);
    originalDestroy?.call(this);
  };

  prototype[PATCH_MARKER] = true;
}
