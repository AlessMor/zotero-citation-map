import type {
  CitationGraphModel,
  CitationGraphNode,
  GraphAxisMetric,
  GraphLayoutOptions,
  GraphNodeColorMetric,
  GraphScaleType,
  MetricID,
} from "../domain/graphTypes";
import {
  formatMetricValue,
  getMetricDefinition,
  metricValue,
} from "./metricRegistry";

interface Position {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GhostPreview {
  key: string;
  title: string;
  year: number | null;
  citationCount: number | null;
  referenceCount: number | null;
  sourceKeys: string[];
}

export interface CitationGraphRendererOptions {
  canvas: HTMLCanvasElement;
  model: CitationGraphModel;
  layout: GraphLayoutOptions;
  collectionColorsByNodeKey: Map<string, string[]>;
  collectionLabelsByNodeKey: Map<string, string[]>;
  onSelectionChange: (node: CitationGraphNode | null) => void;
  onOpenNode: (node: CitationGraphNode) => void;
}

const WORLD_WIDTH = 1100;
const WORLD_HEIGHT = 760;
const PLOT_LEFT = 105;
const PLOT_RIGHT = 1030;
const PLOT_TOP = 60;
const PLOT_BOTTOM = 675;
const MIN_NODE_RADIUS = 4;
const MAX_NODE_RADIUS = 18;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isMetricID(value: GraphNodeColorMetric): value is MetricID {
  return ![
    "collection",
    "publication-type",
    "provider",
    "open-access",
    "retraction",
  ].includes(value);
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function categoricalColor(value: string | null | undefined): string {
  if (!value) return "hsl(220 7% 58%)";
  const hue = hash(value) % 360;
  return `hsl(${hue} 58% 52%)`;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

const GRADIENT_STOPS: Array<[number, RGB]> = [
  [0, { r: 37, g: 99, b: 235 }],
  [0.35, { r: 20, g: 184, b: 211 }],
  [0.68, { r: 250, g: 204, b: 21 }],
  [1, { r: 220, g: 38, b: 38 }],
];

function numericColor(value: number): string {
  const t = clamp(value, 0, 1);
  let left = GRADIENT_STOPS[0];
  let right = GRADIENT_STOPS.at(-1)!;
  for (let index = 1; index < GRADIENT_STOPS.length; index += 1) {
    if (t <= GRADIENT_STOPS[index][0]) {
      left = GRADIENT_STOPS[index - 1];
      right = GRADIENT_STOPS[index];
      break;
    }
  }
  const local = (t - left[0]) / Math.max(1e-9, right[0] - left[0]);
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * local);
  return `rgb(${mix(left[1].r, right[1].r)} ${mix(left[1].g, right[1].g)} ${mix(left[1].b, right[1].b)})`;
}

function scaleValue(
  value: number,
  minimum: number,
  maximum: number,
  scale: GraphScaleType,
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

function unscaleValue(
  position: number,
  minimum: number,
  maximum: number,
  scale: GraphScaleType,
): number {
  if (maximum <= minimum) return minimum;
  if (scale === "log") {
    if (minimum <= 0 || maximum <= 0) return minimum;
    const exponent =
      Math.log(minimum) + position * (Math.log(maximum) - Math.log(minimum));
    return Math.exp(clamp(exponent, -700, 700));
  }
  return minimum + position * (maximum - minimum);
}

function metricNumber(
  node: CitationGraphNode,
  metric: GraphAxisMetric | MetricID,
): number | null {
  if (metric === "free") return null;
  const value = metricValue(node, metric);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metricDomain(
  nodes: CitationGraphNode[],
  metric: GraphAxisMetric | MetricID,
  scale: GraphScaleType,
): [number, number] | null {
  if (metric === "free") return null;
  let values = nodes
    .map((node) => metricNumber(node, metric))
    .filter((value): value is number => value !== null);
  if (scale === "log") values = values.filter((value) => value > 0);
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  // Robust clipping prevents one extreme paper flattening the visual scale.
  const low = values[Math.floor((values.length - 1) * 0.01)];
  const high = values[Math.ceil((values.length - 1) * 0.99)];
  return low === high ? [low - 0.5, high + 0.5] : [low, high];
}

function linearTickValues(
  minimum: number,
  maximum: number,
  targetCount = 7,
): number[] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [];
  if (minimum === maximum) return [minimum];
  const range = Math.abs(maximum - minimum);
  const rawStep = range / Math.max(1, targetCount);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  const start = Math.ceil(minimum / step) * step;
  const values: number[] = [];
  for (let value = start; value <= maximum + step * 1e-8; value += step) {
    values.push(Number(value.toPrecision(12)));
    if (values.length >= 100) break;
  }
  return values;
}

function logarithmicTickValues(minimum: number, maximum: number): number[] {
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    minimum <= 0 ||
    maximum <= 0
  ) {
    return [];
  }
  const values: number[] = [];
  const firstExponent = Math.floor(Math.log10(minimum));
  const lastExponent = Math.ceil(Math.log10(maximum));
  for (let exponent = firstExponent; exponent <= lastExponent; exponent += 1) {
    const power = 10 ** exponent;
    for (const multiplier of [1, 2, 5]) {
      const value = multiplier * power;
      if (value >= minimum && value <= maximum) values.push(value);
    }
  }
  return values;
}

function axisTickValues(
  minimum: number,
  maximum: number,
  scale: GraphScaleType,
): number[] {
  return scale === "log"
    ? logarithmicTickValues(minimum, maximum)
    : linearTickValues(minimum, maximum);
}

export class CitationGraphRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly model: CitationGraphModel;
  private readonly positions = new Map<string, Position>();
  private readonly collectionColorsByNodeKey: Map<string, string[]>;
  private readonly collectionLabelsByNodeKey: Map<string, string[]>;
  private readonly onSelectionChange: (node: CitationGraphNode | null) => void;
  private readonly onOpenNode: (node: CitationGraphNode) => void;
  private visibleKeys: Set<string>;
  private searchMatches: Set<string> | null = null;
  private layout: GraphLayoutOptions;
  private selectedKey: string | null = null;
  private hoverKey: string | null = null;
  private ghostPreview: GhostPreview | null = null;
  private animationFrame: number | null = null;
  private simulationStepsRemaining = 0;
  private initialFitFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private initialFitComplete = false;
  private readonly onResize = (): void => {
    const previousWidth = this.canvas.width;
    const previousHeight = this.canvas.height;
    this.resizeCanvas();

    if (!this.initialFitComplete) {
      this.scheduleInitialFit();
      this.draw();
      return;
    }

    if (previousWidth > 1 && previousHeight > 1) {
      this.transform.x += (this.canvas.width - previousWidth) / 2;
      this.transform.y += (this.canvas.height - previousHeight) / 2;
    }
    this.draw();
  };
  private transform = { x: 0, y: 0, scale: 1 };
  private pointer = { dragging: false, panning: false, x: 0, y: 0 };
  private movedDuringPointer = false;
  private lastClickAt = 0;
  private lastClickedKey: string | null = null;

  constructor(options: CitationGraphRendererOptions) {
    this.canvas = options.canvas;
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Citation Map requires a 2D canvas context.");
    this.context = context;
    this.model = options.model;
    this.layout = { ...options.layout };
    this.collectionColorsByNodeKey = options.collectionColorsByNodeKey;
    this.collectionLabelsByNodeKey = options.collectionLabelsByNodeKey;
    this.onSelectionChange = options.onSelectionChange;
    this.onOpenNode = options.onOpenNode;
    this.visibleKeys = new Set(this.model.nodes.map((node) => node.key));
    this.initializePositions();
    this.projectPositionsToLayout();
    this.installEvents();

    const view = this.canvas.ownerDocument.defaultView;
    const ResizeObserverConstructor = (view as any)?.ResizeObserver as
      | typeof ResizeObserver
      | undefined;

    if (ResizeObserverConstructor) {
      this.resizeObserver = new ResizeObserverConstructor(this.onResize);
      this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    } else {
      view?.addEventListener("resize", this.onResize);
    }

    this.resizeCanvas();
    this.draw();
    this.restartSimulation();
    this.scheduleInitialFit();
  }

  private scheduleInitialFit(): void {
    if (
      this.destroyed ||
      this.initialFitComplete ||
      this.initialFitFrame !== null
    ) {
      return;
    }
    const view = this.canvas.ownerDocument.defaultView;
    if (!view) return;

    let lastWidth = -1;
    let lastHeight = -1;
    let stableFrames = 0;
    let attempts = 0;
    const check = (): void => {
      this.initialFitFrame = null;
      if (this.destroyed || this.initialFitComplete) return;

      this.resizeCanvas();
      const rect = this.canvas.getBoundingClientRect();
      const ready = rect.width >= 240 && rect.height >= 180;
      if (ready) {
        if (
          Math.abs(rect.width - lastWidth) < 0.5 &&
          Math.abs(rect.height - lastHeight) < 0.5
        ) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        lastWidth = rect.width;
        lastHeight = rect.height;
        if (stableFrames >= 2) {
          this.fitView();
          return;
        }
      }

      attempts += 1;
      if (attempts < 120) {
        this.initialFitFrame = view.requestAnimationFrame(check);
      }
    };

    this.initialFitFrame = view.requestAnimationFrame(check);
  }

  private initializePositions(): void {
    const centerX = WORLD_WIDTH / 2;
    const centerY = WORLD_HEIGHT / 2;
    this.model.nodes.forEach((node, index) => {
      const angle = (index * 2.399963229728653) % (Math.PI * 2);
      const radius = 30 + Math.sqrt(index + 1) * 16;
      this.positions.set(node.key, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      });
    });
  }

  private resizeCanvas(): void {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = this.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private screenToWorld(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = this.canvas.width / Math.max(1, rect.width);
    const x = (clientX - rect.left) * ratio;
    const y = (clientY - rect.top) * ratio;
    return {
      x: (x - this.transform.x) / this.transform.scale,
      y: (y - this.transform.y) / this.transform.scale,
    };
  }

  private isDarkMode(): boolean {
    const view = this.canvas.ownerDocument.defaultView;
    return Boolean(view?.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
  }

  private draggableDimensions(): { x: boolean; y: boolean } {
    return {
      x: this.layout.xMetric === "free",
      y: this.layout.yMetric === "free",
    };
  }

  private installEvents(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("mouseleave", this.onMouseLeave);
    this.canvas.ownerDocument.addEventListener("keydown", this.onKeyDown);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.canvas.setPointerCapture?.(event.pointerId);
    const world = this.screenToWorld(event.clientX, event.clientY);
    const hit = this.hitTest(world.x, world.y);
    const draggable = this.draggableDimensions();
    const canDragNode = Boolean(hit) && (draggable.x || draggable.y);
    this.pointer = {
      dragging: canDragNode,
      panning: !hit,
      x: event.clientX,
      y: event.clientY,
    };
    this.movedDuringPointer = false;
    if (hit) {
      this.selectedKey = hit.key;
      this.onSelectionChange(hit);
      this.canvas.style.cursor = canDragNode ? "grabbing" : "pointer";
      this.draw();
    } else {
      this.canvas.style.cursor = "grabbing";
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    const dx = event.clientX - this.pointer.x;
    const dy = event.clientY - this.pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.movedDuringPointer = true;
    if (this.pointer.panning) {
      const ratio = this.canvas.width / Math.max(1, this.canvas.clientWidth);
      this.transform.x += dx * ratio;
      this.transform.y += dy * ratio;
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;
      this.draw();
      return;
    }
    if (this.pointer.dragging && this.selectedKey) {
      const world = this.screenToWorld(event.clientX, event.clientY);
      const position = this.positions.get(this.selectedKey);
      const draggable = this.draggableDimensions();
      if (position) {
        if (draggable.x) position.x = world.x;
        if (draggable.y) position.y = world.y;
        position.vx = 0;
        position.vy = 0;
      }
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;
      this.canvas.style.cursor = "grabbing";
      this.draw();
      return;
    }
    const world = this.screenToWorld(event.clientX, event.clientY);
    const hit = this.hitTest(world.x, world.y);
    const next = hit?.key ?? null;
    if (next !== this.hoverKey) {
      this.hoverKey = next;
      const draggable = this.draggableDimensions();
      this.canvas.style.cursor = next
        ? draggable.x || draggable.y
          ? "grab"
          : "pointer"
        : "grab";
      this.canvas.title = hit ? this.tooltipForNode(hit) : "";
      this.draw();
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    const wasDragging = this.pointer.dragging;
    try {
      this.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer may already be released.
    }
    if (!this.movedDuringPointer && this.selectedKey) {
      const now = Date.now();
      if (
        this.lastClickedKey === this.selectedKey &&
        now - this.lastClickAt < 400
      ) {
        const node = this.model.nodes.find(
          (candidate) => candidate.key === this.selectedKey,
        );
        if (node) this.onOpenNode(node);
      }
      this.lastClickedKey = this.selectedKey;
      this.lastClickAt = now;
    }
    this.pointer.dragging = false;
    this.pointer.panning = false;
    const draggable = this.draggableDimensions();
    this.canvas.style.cursor = this.hoverKey
      ? draggable.x || draggable.y
        ? "grab"
        : "pointer"
      : "grab";
    if (this.movedDuringPointer && wasDragging) this.restartSimulation(120);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const ratio = this.canvas.width / Math.max(1, rect.width);
    const screenX = (event.clientX - rect.left) * ratio;
    const screenY = (event.clientY - rect.top) * ratio;
    const factor = Math.exp(-event.deltaY * 0.0012);
    const nextScale = clamp(this.transform.scale * factor, 0.15, 8);
    const worldX = (screenX - this.transform.x) / this.transform.scale;
    const worldY = (screenY - this.transform.y) / this.transform.scale;
    this.transform.scale = nextScale;
    this.transform.x = screenX - worldX * nextScale;
    this.transform.y = screenY - worldY * nextScale;
    this.draw();
  };

  private onMouseLeave = (): void => {
    if (!this.pointer.dragging && !this.pointer.panning) {
      this.hoverKey = null;
      this.draw();
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key.toLocaleLowerCase() === "f") this.fitView();
    if (event.key === "Escape" && this.selectedKey) {
      this.selectedKey = null;
      this.onSelectionChange(null);
      this.draw();
    }
  };

  private stopSimulation(): void {
    if (this.animationFrame !== null) {
      this.canvas.ownerDocument.defaultView?.cancelAnimationFrame(
        this.animationFrame,
      );
    }
    this.animationFrame = null;
    this.simulationStepsRemaining = 0;
  }

  private stopMotion(): void {
    for (const position of this.positions.values()) {
      position.vx = 0;
      position.vy = 0;
    }
  }

  private restartSimulation(maxSteps = 180): void {
    this.stopSimulation();
    const freeX = this.layout.xMetric === "free";
    const freeY = this.layout.yMetric === "free";

    // A metric-by-metric plot is deterministic. Running the force simulation
    // in this mode only makes nodes oscillate around their metric coordinates.
    if (!freeX && !freeY) {
      this.stopMotion();
      this.draw();
      return;
    }

    const view = this.canvas.ownerDocument.defaultView;
    if (!view) {
      for (let index = 0; index < Math.min(maxSteps, 120); index += 1) {
        if (this.simulate() < 0.002) break;
      }
      this.stopMotion();
      this.draw();
      return;
    }

    this.simulationStepsRemaining = maxSteps;
    const step = (): void => {
      this.animationFrame = null;
      if (this.destroyed) return;

      const motion = this.simulate();
      this.draw();
      this.simulationStepsRemaining -= 1;

      if (this.simulationStepsRemaining > 0 && motion >= 0.002) {
        this.animationFrame = view.requestAnimationFrame(step);
        return;
      }

      this.stopMotion();
      this.draw();
    };

    this.animationFrame = view.requestAnimationFrame(step);
  }

  private visibleNodes(): CitationGraphNode[] {
    return this.model.nodes.filter((node) => this.visibleKeys.has(node.key));
  }

  private visibleEdges() {
    return this.model.edges.filter(
      (edge) =>
        this.visibleKeys.has(edge.source) && this.visibleKeys.has(edge.target),
    );
  }

  private simulate(): number {
    const nodes = this.visibleNodes();
    if (!nodes.length) return 0;

    const freeX = this.layout.xMetric === "free";
    const freeY = this.layout.yMetric === "free";
    if (!freeX && !freeY) return 0;

    const xDomain = metricDomain(
      nodes,
      this.layout.xMetric,
      this.layout.xScale,
    );
    const yDomain = metricDomain(
      nodes,
      this.layout.yMetric,
      this.layout.yScale,
    );

    // Edge attraction only acts along unconstrained dimensions.
    for (const edge of this.visibleEdges()) {
      const source = this.positions.get(edge.source);
      const target = this.positions.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 85) * 0.0009;
      if (freeX) {
        source.vx += dx * force;
        target.vx -= dx * force;
      }
      if (freeY) {
        source.vy += dy * force;
        target.vy -= dy * force;
      }
    }

    // Repulsion also acts only along unconstrained dimensions.
    const maximumComparisons = 250000;
    const stride = Math.max(
      1,
      Math.ceil((nodes.length * nodes.length) / maximumComparisons),
    );
    for (let left = 0; left < nodes.length; left += 1) {
      const a = this.positions.get(nodes[left].key);
      if (!a) continue;
      for (let right = left + 1; right < nodes.length; right += stride) {
        const b = this.positions.get(nodes[right].key);
        if (!b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 1) {
          dx = (hash(nodes[left].key) % 7) - 3;
          dy = (hash(nodes[right].key) % 7) - 3;
          distanceSquared = dx * dx + dy * dy + 1;
        }
        const force = 95 / distanceSquared;
        if (freeX) {
          a.vx += dx * force;
          b.vx -= dx * force;
        }
        if (freeY) {
          a.vy += dy * force;
          b.vy -= dy * force;
        }
      }
    }

    let motion = 0;
    for (const node of nodes) {
      const position = this.positions.get(node.key);
      if (!position) continue;

      if (node.key === this.selectedKey && this.pointer.dragging) continue;

      if (freeX) {
        position.vx += (WORLD_WIDTH / 2 - position.x) * 0.0009;
        position.vx *= 0.82;
        position.x = clamp(position.x + position.vx, 25, WORLD_WIDTH - 25);
        motion += Math.abs(position.vx);
      } else if (xDomain) {
        const value = metricNumber(node, this.layout.xMetric);
        position.x =
          value === null
            ? PLOT_LEFT - 35
            : PLOT_LEFT +
              clamp(
                scaleValue(value, xDomain[0], xDomain[1], this.layout.xScale),
                0,
                1,
              ) *
                (PLOT_RIGHT - PLOT_LEFT);
        position.vx = 0;
      }

      if (freeY) {
        position.vy += (WORLD_HEIGHT / 2 - position.y) * 0.0009;
        position.vy *= 0.82;
        position.y = clamp(position.y + position.vy, 25, WORLD_HEIGHT - 25);
        motion += Math.abs(position.vy);
      } else if (yDomain) {
        const value = metricNumber(node, this.layout.yMetric);
        position.y =
          value === null
            ? PLOT_BOTTOM + 35
            : PLOT_BOTTOM -
              clamp(
                scaleValue(value, yDomain[0], yDomain[1], this.layout.yScale),
                0,
                1,
              ) *
                (PLOT_BOTTOM - PLOT_TOP);
        position.vy = 0;
      }
    }

    return motion / Math.max(1, nodes.length);
  }

  private projectPositionsToLayout(): void {
    const nodes = this.visibleNodes();
    const xDomain = metricDomain(
      nodes,
      this.layout.xMetric,
      this.layout.xScale,
    );
    const yDomain = metricDomain(
      nodes,
      this.layout.yMetric,
      this.layout.yScale,
    );

    for (const node of nodes) {
      const position = this.positions.get(node.key);
      if (!position) continue;

      if (this.layout.xMetric !== "free" && xDomain) {
        const value = metricNumber(node, this.layout.xMetric);
        position.x =
          value === null
            ? PLOT_LEFT - 35
            : PLOT_LEFT +
              clamp(
                scaleValue(value, xDomain[0], xDomain[1], this.layout.xScale),
                0,
                1,
              ) *
                (PLOT_RIGHT - PLOT_LEFT);
      }

      if (this.layout.yMetric !== "free" && yDomain) {
        const value = metricNumber(node, this.layout.yMetric);
        position.y =
          value === null
            ? PLOT_BOTTOM + 35
            : PLOT_BOTTOM -
              clamp(
                scaleValue(value, yDomain[0], yDomain[1], this.layout.yScale),
                0,
                1,
              ) *
                (PLOT_BOTTOM - PLOT_TOP);
      }

      position.vx = 0;
      position.vy = 0;
    }
  }

  private nodeRadius(
    node: CitationGraphNode,
    domains?: Map<string, [number, number] | null>,
  ): number {
    if (this.layout.nodeSizeMetric === "uniform") return 7;
    const value = metricNumber(node, this.layout.nodeSizeMetric);
    if (value === null) return MIN_NODE_RADIUS;
    const key = this.layout.nodeSizeMetric;
    const domain =
      domains?.get(key) ?? metricDomain(this.visibleNodes(), key, "linear");
    if (!domain) return 7;
    const normalized = clamp(
      scaleValue(value, domain[0], domain[1], "linear"),
      0,
      1,
    );
    // Area, rather than radius, represents the value.
    return Math.sqrt(
      MIN_NODE_RADIUS * MIN_NODE_RADIUS +
        normalized *
          (MAX_NODE_RADIUS * MAX_NODE_RADIUS -
            MIN_NODE_RADIUS * MIN_NODE_RADIUS),
    );
  }

  private nodeColors(
    node: CitationGraphNode,
    colorDomain: [number, number] | null,
  ): string[] {
    const metric = this.layout.nodeColorMetric;
    if (metric === "collection") {
      const colors = this.collectionColorsByNodeKey.get(node.key) ?? [];
      if (colors.length <= 4)
        return colors.length ? colors : ["hsl(220 7% 58%)"];
      return [...colors.slice(0, 3), "hsl(220 7% 58%)"];
    }
    if (metric === "publication-type")
      return [categoricalColor(node.publicationType)];
    if (metric === "provider") return [categoricalColor(node.provider)];
    if (metric === "open-access") {
      return [node.isOpenAccess ? "hsl(145 62% 42%)" : "hsl(220 7% 58%)"];
    }
    if (metric === "retraction") {
      return [node.isRetracted ? "hsl(0 72% 51%)" : "hsl(145 35% 48%)"];
    }
    const value = metricNumber(node, metric);
    if (value === null || !colorDomain) return ["hsl(220 7% 58%)"];
    return [
      numericColor(scaleValue(value, colorDomain[0], colorDomain[1], "linear")),
    ];
  }

  private drawNode(
    context: CanvasRenderingContext2D,
    node: CitationGraphNode,
    position: Position,
    radius: number,
    colors: string[],
  ): void {
    const slice = (Math.PI * 2) / Math.max(1, colors.length);
    colors.forEach((color, index) => {
      context.beginPath();
      context.moveTo(position.x, position.y);
      context.arc(
        position.x,
        position.y,
        radius,
        -Math.PI / 2 + slice * index,
        -Math.PI / 2 + slice * (index + 1),
      );
      context.closePath();
      context.fillStyle = color;
      context.fill();
    });

    context.beginPath();
    context.arc(position.x, position.y, radius, 0, Math.PI * 2);
    context.lineWidth = node.isRetracted ? 3 : 1.1;
    context.strokeStyle = node.isRetracted
      ? "rgb(220 38 38)"
      : "rgba(15, 23, 42, 0.78)";
    context.stroke();

    if (this.searchMatches?.has(node.key)) {
      context.beginPath();
      context.arc(position.x, position.y, radius + 4, 0, Math.PI * 2);
      context.lineWidth = 2.5;
      context.strokeStyle = "rgb(250 204 21)";
      context.stroke();
    }
    if (node.key === this.selectedKey) {
      context.beginPath();
      context.arc(position.x, position.y, radius + 5.5, 0, Math.PI * 2);
      context.lineWidth = 3;
      context.strokeStyle = "rgb(30 64 175)";
      context.stroke();
    } else if (node.key === this.hoverKey) {
      context.beginPath();
      context.arc(position.x, position.y, radius + 3, 0, Math.PI * 2);
      context.lineWidth = 2;
      context.strokeStyle = "rgba(30, 64, 175, .8)";
      context.stroke();
    }
  }

  private drawArrow(
    context: CanvasRenderingContext2D,
    source: Position,
    target: Position,
    targetRadius: number,
    manual: boolean,
    highlighted: boolean,
    dimmed: boolean,
  ): void {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / length;
    const uy = dy / length;
    const endX = target.x - ux * (targetRadius + 2);
    const endY = target.y - uy * (targetRadius + 2);
    const dark = this.isDarkMode();
    const normalColor = dark
      ? "rgba(148, 163, 184, .28)"
      : "rgba(71, 85, 105, .32)";
    // Dashed purple edges are local manual relations; provider edges are solid.
    const manualColor = "rgba(124, 58, 237, .68)";
    const highlightedColor = manual
      ? "rgba(196, 181, 253, .98)"
      : "rgba(96, 165, 250, .98)";

    context.save();
    context.beginPath();
    context.moveTo(source.x, source.y);
    context.lineTo(endX, endY);
    context.strokeStyle = highlighted
      ? highlightedColor
      : manual
        ? manualColor
        : dimmed
          ? dark
            ? "rgba(148, 163, 184, .08)"
            : "rgba(71, 85, 105, .08)"
          : normalColor;
    context.lineWidth = highlighted ? 2.7 : manual ? 1.7 : 1;
    context.setLineDash(manual ? [4, 3] : []);
    if (highlighted) {
      context.shadowColor = highlightedColor;
      context.shadowBlur = 9;
    }
    context.stroke();

    const size = highlighted ? 6.5 : 5;
    context.beginPath();
    context.moveTo(endX, endY);
    context.lineTo(
      endX - ux * size - uy * size * 0.7,
      endY - uy * size + ux * size * 0.7,
    );
    context.lineTo(
      endX - ux * size + uy * size * 0.7,
      endY - uy * size - ux * size * 0.7,
    );
    context.closePath();
    context.fillStyle = context.strokeStyle;
    context.fill();
    context.restore();
  }

  private drawAxes(
    context: CanvasRenderingContext2D,
    nodes: CitationGraphNode[],
  ): void {
    const ratio =
      this.canvas.width /
      Math.max(1, this.canvas.getBoundingClientRect().width);
    const axisLeft = 58 * ratio;
    const axisRight = this.canvas.width - 14 * ratio;
    const axisTop = 14 * ratio;
    const axisBottom = this.canvas.height - 42 * ratio;
    const dark = this.isDarkMode();
    const foreground = dark
      ? "rgba(226, 232, 240, .72)"
      : "rgba(51, 65, 85, .72)";
    const backdrop = dark
      ? "rgba(15, 23, 42, .58)"
      : "rgba(255, 255, 255, .62)";

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.lineWidth = Math.max(1, ratio);
    context.strokeStyle = foreground;
    context.fillStyle = foreground;
    context.font = `${Math.round(11 * ratio)}px sans-serif`;

    if (this.layout.xMetric !== "free") {
      context.fillStyle = backdrop;
      context.fillRect(
        0,
        axisBottom - 2 * ratio,
        this.canvas.width,
        this.canvas.height,
      );
      context.strokeStyle = foreground;
      context.fillStyle = foreground;
      context.beginPath();
      context.moveTo(axisLeft, axisBottom);
      context.lineTo(axisRight, axisBottom);
      context.stroke();

      const domain = metricDomain(
        nodes,
        this.layout.xMetric,
        this.layout.xScale,
      );
      if (domain) {
        const visibleWorldLeft =
          (axisLeft - this.transform.x) / this.transform.scale;
        const visibleWorldRight =
          (axisRight - this.transform.x) / this.transform.scale;
        const visibleValues = [visibleWorldLeft, visibleWorldRight].map(
          (worldX) =>
            unscaleValue(
              (worldX - PLOT_LEFT) / (PLOT_RIGHT - PLOT_LEFT),
              domain[0],
              domain[1],
              this.layout.xScale,
            ),
        );
        const definition = getMetricDefinition(this.layout.xMetric);
        const rawMinimum = Math.min(...visibleValues);
        const rawMaximum = Math.max(...visibleValues);
        const visibleMinimum = definition.allowsNegative
          ? rawMinimum
          : Math.max(0, rawMinimum);
        const visibleMaximum = Math.max(visibleMinimum, rawMaximum);
        for (const tick of axisTickValues(
          visibleMinimum,
          visibleMaximum,
          this.layout.xScale,
        )) {
          const worldX =
            PLOT_LEFT +
            scaleValue(tick, domain[0], domain[1], this.layout.xScale) *
              (PLOT_RIGHT - PLOT_LEFT);
          const x = this.transform.x + worldX * this.transform.scale;
          if (x < axisLeft + 8 * ratio || x > axisRight - 8 * ratio) continue;
          context.beginPath();
          context.moveTo(x, axisBottom);
          context.lineTo(x, axisBottom + 5 * ratio);
          context.stroke();
          context.textAlign = "center";
          context.textBaseline = "top";
          context.fillText(
            formatMetricValue(this.layout.xMetric, tick),
            x,
            axisBottom + 7 * ratio,
          );
        }
      }
      context.font = `600 ${Math.round(12 * ratio)}px sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "bottom";
      context.fillText(
        getMetricDefinition(this.layout.xMetric).label,
        (axisLeft + axisRight) / 2,
        this.canvas.height - 3 * ratio,
      );
    }

    if (this.layout.yMetric !== "free") {
      context.fillStyle = backdrop;
      context.fillRect(0, 0, axisLeft + 2 * ratio, this.canvas.height);
      context.strokeStyle = foreground;
      context.fillStyle = foreground;
      context.beginPath();
      context.moveTo(axisLeft, axisTop);
      context.lineTo(axisLeft, axisBottom);
      context.stroke();

      const domain = metricDomain(
        nodes,
        this.layout.yMetric,
        this.layout.yScale,
      );
      if (domain) {
        const visibleWorldTop =
          (axisTop - this.transform.y) / this.transform.scale;
        const visibleWorldBottom =
          (axisBottom - this.transform.y) / this.transform.scale;
        const visibleValues = [visibleWorldTop, visibleWorldBottom].map(
          (worldY) =>
            unscaleValue(
              (PLOT_BOTTOM - worldY) / (PLOT_BOTTOM - PLOT_TOP),
              domain[0],
              domain[1],
              this.layout.yScale,
            ),
        );
        const definition = getMetricDefinition(this.layout.yMetric);
        const rawMinimum = Math.min(...visibleValues);
        const rawMaximum = Math.max(...visibleValues);
        const visibleMinimum = definition.allowsNegative
          ? rawMinimum
          : Math.max(0, rawMinimum);
        const visibleMaximum = Math.max(visibleMinimum, rawMaximum);
        for (const tick of axisTickValues(
          visibleMinimum,
          visibleMaximum,
          this.layout.yScale,
        )) {
          const worldY =
            PLOT_BOTTOM -
            scaleValue(tick, domain[0], domain[1], this.layout.yScale) *
              (PLOT_BOTTOM - PLOT_TOP);
          const y = this.transform.y + worldY * this.transform.scale;
          if (y < axisTop + 8 * ratio || y > axisBottom - 8 * ratio) continue;
          context.beginPath();
          context.moveTo(axisLeft - 5 * ratio, y);
          context.lineTo(axisLeft, y);
          context.stroke();
          context.textAlign = "right";
          context.textBaseline = "middle";
          context.fillText(
            formatMetricValue(this.layout.yMetric, tick),
            axisLeft - 8 * ratio,
            y,
          );
        }
      }
      context.save();
      context.translate(13 * ratio, (axisTop + axisBottom) / 2);
      context.rotate(-Math.PI / 2);
      context.font = `600 ${Math.round(12 * ratio)}px sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "top";
      context.fillText(getMetricDefinition(this.layout.yMetric).label, 0, 0);
      context.restore();
    }
    context.restore();
  }

  private drawLabels(
    context: CanvasRenderingContext2D,
    nodes: CitationGraphNode[],
    radii: Map<string, number>,
  ): void {
    if (this.layout.nodeLabelMode === "none") return;
    context.font = "11px sans-serif";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = this.isDarkMode()
      ? "rgba(248, 250, 252, .94)"
      : "rgba(15, 23, 42, .9)";
    for (const node of nodes) {
      if (
        nodes.length > 220 &&
        node.key !== this.selectedKey &&
        node.key !== this.hoverKey
      ) {
        continue;
      }
      const position = this.positions.get(node.key);
      if (!position) continue;
      const text =
        this.layout.nodeLabelMode === "author-year"
          ? `${node.authors[0]?.split(/\s+/).at(-1) ?? "Unknown"}${node.year ? ` (${node.year})` : ""}`
          : node.title;
      const shortened = text.length > 42 ? `${text.slice(0, 39)}…` : text;
      context.fillText(
        shortened,
        position.x + (radii.get(node.key) ?? 7) + 5,
        position.y,
      );
    }
  }

  private drawLegend(
    context: CanvasRenderingContext2D,
    colorDomain: [number, number] | null,
  ): void {
    if (!isMetricID(this.layout.nodeColorMetric) || !colorDomain) return;
    const x = WORLD_WIDTH - 250;
    const y = 24;
    const width = 190;
    const height = 10;
    const gradient = context.createLinearGradient(x, y, x + width, y);
    for (const [stop, rgb] of GRADIENT_STOPS) {
      gradient.addColorStop(stop, `rgb(${rgb.r} ${rgb.g} ${rgb.b})`);
    }
    context.fillStyle = gradient;
    context.fillRect(x, y, width, height);
    context.strokeStyle = this.isDarkMode()
      ? "rgba(226, 232, 240, .48)"
      : "rgba(30, 41, 59, .4)";
    context.strokeRect(x, y, width, height);
    context.fillStyle = this.isDarkMode()
      ? "rgba(248, 250, 252, .94)"
      : "rgba(30, 41, 59, .9)";
    context.font = "11px sans-serif";
    context.textBaseline = "top";
    context.textAlign = "left";
    context.fillText(
      formatMetricValue(this.layout.nodeColorMetric, colorDomain[0]),
      x,
      y + 14,
    );
    context.textAlign = "right";
    context.fillText(
      formatMetricValue(this.layout.nodeColorMetric, colorDomain[1]),
      x + width,
      y + 14,
    );
    context.textAlign = "center";
    context.font = "600 11px sans-serif";
    context.fillText(
      getMetricDefinition(this.layout.nodeColorMetric).label,
      x + width / 2,
      y - 16,
    );
  }

  private drawGhost(context: CanvasRenderingContext2D): void {
    if (!this.ghostPreview) return;
    const sources = this.ghostPreview.sourceKeys
      .map((key) => this.positions.get(key))
      .filter((position): position is Position => Boolean(position));
    if (!sources.length) return;
    const x =
      sources.reduce((sum, source) => sum + source.x, 0) / sources.length;
    const y =
      sources.reduce((sum, source) => sum + source.y, 0) / sources.length + 75;
    context.save();
    context.setLineDash([6, 5]);
    for (const source of sources) {
      context.beginPath();
      context.moveTo(source.x, source.y);
      context.lineTo(x, y);
      context.strokeStyle = "rgba(100, 116, 139, .55)";
      context.stroke();
    }
    context.beginPath();
    context.arc(x, y, 12, 0, Math.PI * 2);
    context.fillStyle = "rgba(148, 163, 184, .45)";
    context.fill();
    context.strokeStyle = this.isDarkMode()
      ? "rgba(226, 232, 240, .8)"
      : "rgba(71, 85, 105, .8)";
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = this.isDarkMode()
      ? "rgba(248, 250, 252, .94)"
      : "rgba(30, 41, 59, .9)";
    context.font = "11px sans-serif";
    context.textAlign = "center";
    const title = this.ghostPreview.title;
    context.fillText(
      title.length > 50 ? `${title.slice(0, 47)}…` : title,
      x,
      y + 25,
    );
    context.restore();
  }

  private draw(): void {
    if (this.destroyed) return;
    const ratio = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const context = this.context;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = "rgba(255, 255, 255, 0.001)";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.translate(this.transform.x, this.transform.y);
    context.scale(this.transform.scale, this.transform.scale);

    const nodes = this.visibleNodes();
    const sizeDomains = new Map<string, [number, number] | null>();
    if (this.layout.nodeSizeMetric !== "uniform") {
      sizeDomains.set(
        this.layout.nodeSizeMetric,
        metricDomain(nodes, this.layout.nodeSizeMetric, "linear"),
      );
    }
    const colorDomain = isMetricID(this.layout.nodeColorMetric)
      ? metricDomain(nodes, this.layout.nodeColorMetric, "linear")
      : null;
    const radii = new Map(
      nodes.map((node) => [node.key, this.nodeRadius(node, sizeDomains)]),
    );

    const selectedKey = this.selectedKey;
    const edges = this.visibleEdges();
    edges.sort((left, right) => {
      const leftConnected =
        selectedKey !== null &&
        (left.source === selectedKey || left.target === selectedKey);
      const rightConnected =
        selectedKey !== null &&
        (right.source === selectedKey || right.target === selectedKey);
      return Number(leftConnected) - Number(rightConnected);
    });
    for (const edge of edges) {
      const source = this.positions.get(edge.source);
      const target = this.positions.get(edge.target);
      if (!source || !target) continue;
      const highlighted =
        selectedKey !== null &&
        (edge.source === selectedKey || edge.target === selectedKey);
      this.drawArrow(
        context,
        source,
        target,
        radii.get(edge.target) ?? 7,
        edge.manual,
        highlighted,
        selectedKey !== null && !highlighted,
      );
    }
    for (const node of nodes) {
      const position = this.positions.get(node.key);
      if (!position) continue;
      this.drawNode(
        context,
        node,
        position,
        radii.get(node.key) ?? 7,
        this.nodeColors(node, colorDomain),
      );
    }
    this.drawLabels(context, nodes, radii);
    this.drawLegend(context, colorDomain);
    this.drawGhost(context);
    context.restore();
    this.drawAxes(context, nodes);
    // Keep text and geometry crisp on high-DPI canvases.
    if (ratio < 0) Zotero.debug(String(ratio));
  }

  private hitTest(x: number, y: number): CitationGraphNode | null {
    const nodes = this.visibleNodes();
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      const position = this.positions.get(node.key);
      if (!position) continue;
      const radius = this.nodeRadius(node) + 5;
      if (Math.hypot(position.x - x, position.y - y) <= radius) return node;
    }
    return null;
  }

  private tooltipForNode(node: CitationGraphNode): string {
    const collections = this.collectionLabelsByNodeKey.get(node.key) ?? [];
    return [
      node.title,
      node.authors.slice(0, 3).join(", "),
      node.year ? String(node.year) : "",
      node.citationCount === null ? "" : `${node.citationCount} citations`,
      collections.length ? collections.join(" · ") : "Unfiled",
      node.isRetracted ? "RETRACTED" : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  public setVisibleKeys(keys: Set<string>): void {
    this.visibleKeys = new Set(keys);
    if (this.selectedKey && !this.visibleKeys.has(this.selectedKey)) {
      this.selectedKey = null;
      this.onSelectionChange(null);
    }
    this.projectPositionsToLayout();
    this.restartSimulation();
    this.draw();
  }

  public setSearchMatches(keys: Set<string> | null): void {
    this.searchMatches = keys ? new Set(keys) : null;
    this.draw();
  }

  public selectNode(key: string, center = true): boolean {
    if (!this.visibleKeys.has(key)) return false;
    const node = this.model.nodes.find((candidate) => candidate.key === key);
    if (!node) return false;
    this.selectedKey = key;
    this.onSelectionChange(node);
    if (center) {
      const position = this.positions.get(key);
      if (position) {
        this.transform.x =
          this.canvas.width / 2 - position.x * this.transform.scale;
        this.transform.y =
          this.canvas.height / 2 - position.y * this.transform.scale;
      }
    }
    this.draw();
    return true;
  }

  public setLayout(layout: GraphLayoutOptions): void {
    this.layout = { ...layout };
    this.projectPositionsToLayout();
    this.restartSimulation();
    const draggable = this.draggableDimensions();
    this.canvas.style.cursor = this.hoverKey
      ? draggable.x || draggable.y
        ? "grab"
        : "pointer"
      : "grab";
    this.draw();
  }

  public getLayout(): GraphLayoutOptions {
    return { ...this.layout };
  }

  public setGhostPreview(preview: GhostPreview | null): void {
    this.ghostPreview = preview;
    this.draw();
  }

  public getVisibleEdgeCount(): number {
    return this.visibleEdges().length;
  }

  public resizeViewport(): void {
    this.onResize();
  }

  public zoomBy(factor: number): void {
    this.initialFitComplete = true;
    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;
    const next = clamp(this.transform.scale * factor, 0.15, 8);
    const worldX = (centerX - this.transform.x) / this.transform.scale;
    const worldY = (centerY - this.transform.y) / this.transform.scale;
    this.transform.scale = next;
    this.transform.x = centerX - worldX * next;
    this.transform.y = centerY - worldY * next;
    this.draw();
  }

  public fitView(): void {
    this.initialFitComplete = true;
    this.resizeCanvas();

    const rect = this.canvas.getBoundingClientRect();
    const ratio = this.canvas.width / Math.max(1, rect.width);
    const viewportLeft = 72 * ratio;
    const viewportRight = this.canvas.width - 24 * ratio;
    const viewportTop = 24 * ratio;
    const viewportBottom = this.canvas.height - 54 * ratio;
    const availableWidth = Math.max(1, viewportRight - viewportLeft);
    const availableHeight = Math.max(1, viewportBottom - viewportTop);

    const positions = this.visibleNodes()
      .map((node) => this.positions.get(node.key))
      .filter((position): position is Position => Boolean(position));
    if (positions.length === 0) {
      this.transform.scale = 1;
      this.transform.x = this.canvas.width / 2 - WORLD_WIDTH / 2;
      this.transform.y = this.canvas.height / 2 - WORLD_HEIGHT / 2;
      this.draw();
      return;
    }

    const worldPadding = 34;
    const minimumX =
      Math.min(...positions.map((position) => position.x)) - worldPadding;
    const maximumX =
      Math.max(...positions.map((position) => position.x)) + worldPadding;
    const minimumY =
      Math.min(...positions.map((position) => position.y)) - worldPadding;
    const maximumY =
      Math.max(...positions.map((position) => position.y)) + worldPadding;
    const boundsWidth = Math.max(80, maximumX - minimumX);
    const boundsHeight = Math.max(80, maximumY - minimumY);
    const scale = clamp(
      Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight),
      0.15,
      8,
    );

    this.transform.scale = scale;
    this.transform.x =
      viewportLeft +
      (availableWidth - boundsWidth * scale) / 2 -
      minimumX * scale;
    this.transform.y =
      viewportTop +
      (availableHeight - boundsHeight * scale) / 2 -
      minimumY * scale;
    this.draw();
  }

  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopSimulation();
    if (this.initialFitFrame !== null) {
      this.canvas.ownerDocument.defaultView?.cancelAnimationFrame(
        this.initialFitFrame,
      );
    }
    this.resizeObserver?.disconnect();
    this.canvas.ownerDocument.defaultView?.removeEventListener(
      "resize",
      this.onResize,
    );
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("mouseleave", this.onMouseLeave);
    this.canvas.ownerDocument.removeEventListener("keydown", this.onKeyDown);
  }
}
