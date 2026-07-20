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
  onBackgroundInteraction?: () => void;
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
  return `hsl(${hash(value) % 360} 58% 52%)`;
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

function metricNumber(
  node: CitationGraphNode,
  metric: GraphAxisMetric | MetricID,
): number | null {
  if (metric === "free") return null;
  const value = metricValue(node, metric);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metricExtent(
  nodes: CitationGraphNode[],
  metric: GraphAxisMetric | MetricID,
  scale: GraphScaleType = "linear",
): [number, number] | null {
  if (metric === "free") return null;
  const values = nodes
    .map((node) => metricNumber(node, metric))
    .filter(
      (value): value is number =>
        value !== null && (scale !== "log" || value > 0),
    );
  if (!values.length) return null;
  return [Math.min(...values), Math.max(...values)];
}

function axisDomain(
  nodes: CitationGraphNode[],
  metric: GraphAxisMetric,
  scale: GraphScaleType,
): [number, number] | null {
  if (metric === "free") return null;
  let values = nodes
    .map((node) => metricNumber(node, metric))
    .filter(
      (value): value is number =>
        value !== null && (scale !== "log" || value > 0),
    )
    .sort((a, b) => a - b);
  if (!values.length) return null;
  if (values.length > 20) {
    values = values.slice(
      Math.floor(values.length * 0.01),
      Math.ceil(values.length * 0.99),
    );
  }
  const minimum = values[0];
  const maximum = values.at(-1)!;
  if (minimum !== maximum) return [minimum, maximum];
  if (scale === "log" && minimum > 0) {
    return [minimum / 1.25, minimum * 1.25];
  }
  const integer = getMetricDefinition(metric).valueType === "integer";
  const padding = integer
    ? Math.max(1, Math.ceil(Math.abs(minimum) * 0.02))
    : Math.max(0.5, Math.abs(minimum) * 0.02);
  return [minimum - padding, maximum + padding];
}

function tickValues(
  minimum: number,
  maximum: number,
  metric: GraphAxisMetric,
  scale: GraphScaleType,
  target = 6,
): number[] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [];
  if (minimum === maximum) return [minimum];
  if (scale === "log") {
    if (minimum <= 0 || maximum <= 0) return [];
    const values: number[] = [];
    const firstExponent = Math.floor(Math.log10(minimum));
    const lastExponent = Math.ceil(Math.log10(maximum));
    for (
      let exponent = firstExponent;
      exponent <= lastExponent;
      exponent += 1
    ) {
      const power = 10 ** exponent;
      for (const multiplier of [1, 2, 5]) {
        const value = multiplier * power;
        if (value >= minimum && value <= maximum) values.push(value);
      }
    }
    return values.length ? values : [minimum, maximum];
  }
  const rawStep = Math.abs(maximum - minimum) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const nice =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const integer =
    metric !== "free" && getMetricDefinition(metric).valueType === "integer";
  const step = integer
    ? Math.max(1, Math.ceil(nice * magnitude))
    : nice * magnitude;
  const values: number[] = [];
  for (
    let value = Math.ceil(minimum / step) * step;
    value <= maximum + step * 1e-8;
    value += step
  ) {
    values.push(Number(value.toPrecision(12)));
    if (values.length > 20) break;
  }
  return values.length ? values : [minimum, maximum];
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
  private readonly onBackgroundInteraction: () => void;
  private visibleKeys: Set<string>;
  private searchMatches: Set<string> | null = null;
  private layout: GraphLayoutOptions;
  private selectedKey: string | null = null;
  private hoverKey: string | null = null;
  private ghostPreview: GhostPreview | null = null;
  private transform = { x: 0, y: 0, scale: 1 };
  private pointer = {
    down: false,
    panning: false,
    x: 0,
    y: 0,
    startX: 0,
    startY: 0,
    moved: false,
  };
  private resizeObserver: ResizeObserver | null = null;
  private colorSchemeQuery: MediaQueryList | null = null;
  private initialFitFrame: number | null = null;
  private initialFitComplete = false;
  private destroyed = false;

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
    this.onBackgroundInteraction =
      options.onBackgroundInteraction ?? (() => undefined);
    this.visibleKeys = new Set(this.model.nodes.map((node) => node.key));
    this.initializePositions();
    this.installEvents();
    const view = this.canvas.ownerDocument.defaultView;
    this.colorSchemeQuery =
      view?.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    this.colorSchemeQuery?.addEventListener?.(
      "change",
      this.onColorSchemeChange,
    );
    const ResizeObserverConstructor = (view as any)?.ResizeObserver as
      typeof ResizeObserver | undefined;
    if (ResizeObserverConstructor) {
      this.resizeObserver = new ResizeObserverConstructor(() => {
        this.resizeViewport();
        if (!this.initialFitComplete) this.scheduleInitialFit();
      });
      this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    } else {
      view?.addEventListener("resize", this.resizeViewport);
    }
    this.resizeViewport();
    this.draw();
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

    let previousWidth = -1;
    let previousHeight = -1;
    let stableFrames = 0;
    let attempts = 0;
    const check = (): void => {
      this.initialFitFrame = null;
      if (this.destroyed || this.initialFitComplete) return;
      this.resizeViewport();
      const rect = (
        this.canvas.parentElement ?? this.canvas
      ).getBoundingClientRect();
      const ready = rect.width >= 240 && rect.height >= 180;
      if (ready) {
        if (
          Math.abs(rect.width - previousWidth) < 0.5 &&
          Math.abs(rect.height - previousHeight) < 0.5
        ) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
        }
        previousWidth = rect.width;
        previousHeight = rect.height;
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

  private markViewAdjusted(): void {
    this.initialFitComplete = true;
    if (this.initialFitFrame !== null) {
      this.canvas.ownerDocument.defaultView?.cancelAnimationFrame(
        this.initialFitFrame,
      );
      this.initialFitFrame = null;
    }
  }

  private initializePositions(): void {
    this.model.nodes.forEach((node, index) => {
      const angle = (index * 2.399963229728653) % (Math.PI * 2);
      const radius = 25 + Math.sqrt(index + 1) * 17;
      this.positions.set(node.key, {
        x: WORLD_WIDTH / 2 + Math.cos(angle) * radius,
        y: WORLD_HEIGHT / 2 + Math.sin(angle) * radius,
      });
    });
    this.projectPositionsToLayout();
  }

  private installEvents(): void {
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("keydown", this.onKeyDown);
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

  private projectPositionsToLayout(): void {
    const nodes = this.visibleNodes();
    const xDomain = axisDomain(nodes, this.layout.xMetric, this.layout.xScale);
    const yDomain = axisDomain(nodes, this.layout.yMetric, this.layout.yScale);
    for (const [index, node] of nodes.entries()) {
      const position = this.positions.get(node.key)!;
      if (this.layout.xMetric === "free") {
        const angle = (index * 2.399963229728653) % (Math.PI * 2);
        position.x =
          WORLD_WIDTH / 2 + Math.cos(angle) * (60 + Math.sqrt(index + 1) * 18);
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
      }
      if (this.layout.yMetric === "free") {
        const angle = (index * 2.399963229728653) % (Math.PI * 2);
        position.y =
          WORLD_HEIGHT / 2 + Math.sin(angle) * (60 + Math.sqrt(index + 1) * 18);
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
      }
    }
  }

  private screenToWorld(clientX: number, clientY: number): Position {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = this.canvas.width / Math.max(1, rect.width);
    const x = (clientX - rect.left) * ratio;
    const y = (clientY - rect.top) * ratio;
    return {
      x: (x - this.transform.x) / this.transform.scale,
      y: (y - this.transform.y) / this.transform.scale,
    };
  }

  private nodeRadius(
    node: CitationGraphNode,
    domain?: [number, number] | null,
  ): number {
    const metric = this.layout.nodeSizeMetric;
    if (metric === "uniform") return 7;
    const value = metricNumber(node, metric);
    if (value === null) return MIN_NODE_RADIUS;
    const visibleNodes = this.visibleNodes();
    const resolved = domain ?? metricExtent(visibleNodes, metric);
    if (!resolved) return 7;
    if (resolved[0] === resolved[1]) {
      const hasMissingValues = visibleNodes.some(
        (visibleNode) => metricNumber(visibleNode, metric) === null,
      );
      return hasMissingValues
        ? MAX_NODE_RADIUS
        : (MIN_NODE_RADIUS + MAX_NODE_RADIUS) / 2;
    }
    const normalized = clamp(
      scaleValue(value, resolved[0], resolved[1], "linear"),
      0,
      1,
    );
    return Math.sqrt(
      MIN_NODE_RADIUS * MIN_NODE_RADIUS +
        normalized *
          (MAX_NODE_RADIUS * MAX_NODE_RADIUS -
            MIN_NODE_RADIUS * MIN_NODE_RADIUS),
    );
  }

  private hitTest(x: number, y: number): CitationGraphNode | null {
    const domain =
      this.layout.nodeSizeMetric === "uniform"
        ? null
        : metricExtent(this.visibleNodes(), this.layout.nodeSizeMetric);
    const nodes = this.visibleNodes();
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      const position = this.positions.get(node.key);
      if (!position) continue;
      if (
        Math.hypot(position.x - x, position.y - y) <=
        this.nodeRadius(node, domain) + 5
      )
        return node;
    }
    return null;
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.markViewAdjusted();
    this.canvas.setPointerCapture?.(event.pointerId);
    const world = this.screenToWorld(event.clientX, event.clientY);
    const node = this.hitTest(world.x, world.y);
    this.pointer = {
      down: true,
      panning: !node,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    if (node) {
      this.selectedKey = node.key;
      this.onSelectionChange(node);
      this.draw();
      return;
    }
    // Defer background-click handling until pointerup so that a click can be
    // distinguished from a pan gesture. Graph controls and settings live
    // outside the canvas and therefore never clear the current selection.
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.pointer.down && this.pointer.panning) {
      const totalMovement = Math.hypot(
        event.clientX - this.pointer.startX,
        event.clientY - this.pointer.startY,
      );
      if (totalMovement > 4) this.pointer.moved = true;
      const rect = this.canvas.getBoundingClientRect();
      const ratio = this.canvas.width / Math.max(1, rect.width);
      this.transform.x += (event.clientX - this.pointer.x) * ratio;
      this.transform.y += (event.clientY - this.pointer.y) * ratio;
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;
      this.draw();
      return;
    }
    const world = this.screenToWorld(event.clientX, event.clientY);
    const node = this.hitTest(world.x, world.y);
    const key = node?.key ?? null;
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      this.canvas.style.cursor = node ? "pointer" : "grab";
      this.canvas.title = node ? this.tooltipForNode(node) : "";
      this.draw();
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.canvas.releasePointerCapture?.(event.pointerId);
    const wasBackgroundClick =
      this.pointer.down && this.pointer.panning && !this.pointer.moved;
    this.pointer.down = false;
    this.pointer.panning = false;
    if (wasBackgroundClick) {
      const world = this.screenToWorld(event.clientX, event.clientY);
      if (!this.hitTest(world.x, world.y)) {
        this.clearSelection();
        this.onBackgroundInteraction();
      }
    }
  };

  private onPointerLeave = (): void => {
    if (!this.pointer.down) {
      this.hoverKey = null;
      this.canvas.title = "";
      this.draw();
    }
  };

  private onDoubleClick = (event: MouseEvent): void => {
    const world = this.screenToWorld(event.clientX, event.clientY);
    const node = this.hitTest(world.x, world.y);
    if (node) this.onOpenNode(node);
  };

  private onWheel = (event: WheelEvent): void => {
    this.markViewAdjusted();
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

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key.toLocaleLowerCase() === "f") this.fitView();
    if (event.key === "Escape") {
      this.clearSelection();
      this.onBackgroundInteraction();
    }
  };

  private readonly onColorSchemeChange = (): void => {
    this.draw();
  };

  private isDarkMode(): boolean {
    return this.colorSchemeQuery?.matches ?? false;
  }

  private nodeColors(
    node: CitationGraphNode,
    colorDomain: [number, number] | null,
  ): string[] {
    const metric = this.layout.nodeColorMetric;
    if (metric === "collection") {
      const colors = this.collectionColorsByNodeKey.get(node.key) ?? [];
      return colors.length ? colors.slice(0, 4) : ["hsl(220 7% 58%)"];
    }
    if (metric === "publication-type")
      return [categoricalColor(node.publicationType)];
    if (metric === "provider") return [categoricalColor(node.provider)];
    if (metric === "open-access")
      return [node.isOpenAccess ? "hsl(145 62% 42%)" : "hsl(220 7% 58%)"];
    if (metric === "retraction")
      return [node.isRetracted ? "hsl(0 72% 51%)" : "hsl(145 35% 48%)"];
    const value = metricNumber(node, metric);
    if (value === null || !colorDomain) return ["hsl(220 7% 58%)"];
    return [
      numericColor(scaleValue(value, colorDomain[0], colorDomain[1], "linear")),
    ];
  }

  private drawNode(
    node: CitationGraphNode,
    position: Position,
    radius: number,
    colors: string[],
  ): void {
    const context = this.context;
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
      : this.isDarkMode()
        ? "rgba(226, 232, 240, .75)"
        : "rgba(15, 23, 42, .78)";
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
    source: Position,
    target: Position,
    targetRadius: number,
    connection: "citation" | "reference" | null,
    dimmed: boolean,
  ): void {
    const context = this.context;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / length;
    const uy = dy / length;
    const endX = target.x - ux * (targetRadius + 2);
    const endY = target.y - uy * (targetRadius + 2);
    const dark = this.isDarkMode();
    const normal = dark ? "rgba(148, 163, 184, .28)" : "rgba(71, 85, 105, .32)";
    const connected =
      connection === "citation"
        ? "rgba(249, 115, 22, .92)"
        : "rgba(59, 130, 246, .92)";
    context.save();
    context.beginPath();
    context.moveTo(source.x, source.y);
    context.lineTo(endX, endY);
    context.strokeStyle = connection
      ? connected
      : dimmed
        ? dark
          ? "rgba(148, 163, 184, .07)"
          : "rgba(71, 85, 105, .07)"
        : normal;
    context.lineWidth = connection ? 2.15 : 1;
    context.setLineDash([]);
    if (connection) {
      context.shadowColor = connected;
      context.shadowBlur = 3;
    }
    context.stroke();
    const size = connection ? 6.25 : 5;
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

  private drawAxes(nodes: CitationGraphNode[]): void {
    const context = this.context;
    const ratio =
      this.canvas.width /
      Math.max(1, this.canvas.getBoundingClientRect().width);
    const axisLeft = 58 * ratio;
    const axisRight = this.canvas.width - 14 * ratio;
    const axisTop = 14 * ratio;
    const axisBottom = this.canvas.height - 42 * ratio;
    const foreground = this.isDarkMode()
      ? "rgba(226, 232, 240, .72)"
      : "rgba(51, 65, 85, .72)";
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.strokeStyle = foreground;
    context.fillStyle = foreground;
    context.lineWidth = Math.max(1, ratio);
    context.font = `${Math.round(11 * ratio)}px sans-serif`;
    if (this.layout.xMetric !== "free") {
      context.beginPath();
      context.moveTo(axisLeft, axisBottom);
      context.lineTo(axisRight, axisBottom);
      context.stroke();
      const domain = axisDomain(nodes, this.layout.xMetric, this.layout.xScale);
      if (domain) {
        for (const tick of tickValues(
          domain[0],
          domain[1],
          this.layout.xMetric,
          this.layout.xScale,
        )) {
          const worldX =
            PLOT_LEFT +
            scaleValue(tick, domain[0], domain[1], this.layout.xScale) *
              (PLOT_RIGHT - PLOT_LEFT);
          const x = this.transform.x + worldX * this.transform.scale;
          if (x < axisLeft || x > axisRight) continue;
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
      } else {
        context.textAlign = "center";
        context.textBaseline = "bottom";
        context.fillText(
          "No visible data",
          (axisLeft + axisRight) / 2,
          axisBottom - 7 * ratio,
        );
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
      context.beginPath();
      context.moveTo(axisLeft, axisTop);
      context.lineTo(axisLeft, axisBottom);
      context.stroke();
      const domain = axisDomain(nodes, this.layout.yMetric, this.layout.yScale);
      if (domain) {
        for (const tick of tickValues(
          domain[0],
          domain[1],
          this.layout.yMetric,
          this.layout.yScale,
        )) {
          const worldY =
            PLOT_BOTTOM -
            scaleValue(tick, domain[0], domain[1], this.layout.yScale) *
              (PLOT_BOTTOM - PLOT_TOP);
          const y = this.transform.y + worldY * this.transform.scale;
          if (y < axisTop || y > axisBottom) continue;
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
      } else {
        context.textAlign = "left";
        context.textBaseline = "top";
        context.fillText("No visible data", axisLeft + 8 * ratio, axisTop);
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
    nodes: CitationGraphNode[],
    radii: Map<string, number>,
  ): void {
    if (this.layout.nodeLabelMode === "none") return;
    const context = this.context;
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
      )
        continue;
      const position = this.positions.get(node.key);
      if (!position) continue;
      const label =
        this.layout.nodeLabelMode === "author-year"
          ? `${node.authors[0]?.split(/\s+/).at(-1) ?? "Unknown"}${node.year ? ` (${node.year})` : ""}`
          : node.title;
      const shortened = label.length > 42 ? `${label.slice(0, 39)}…` : label;
      context.fillText(
        shortened,
        position.x + (radii.get(node.key) ?? 7) + 5,
        position.y,
      );
    }
  }

  private drawLegend(colorDomain: [number, number] | null): void {
    if (!isMetricID(this.layout.nodeColorMetric) || !colorDomain) return;
    const context = this.context;
    const x = WORLD_WIDTH - 250;
    const y = 24;
    const width = 190;
    const gradient = context.createLinearGradient(x, y, x + width, y);
    for (const [stop, rgb] of GRADIENT_STOPS)
      gradient.addColorStop(stop, `rgb(${rgb.r} ${rgb.g} ${rgb.b})`);
    context.fillStyle = gradient;
    context.fillRect(x, y, width, 10);
    context.fillStyle = this.isDarkMode()
      ? "rgba(248,250,252,.94)"
      : "rgba(30,41,59,.9)";
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

  private drawGhost(): void {
    if (!this.ghostPreview) return;
    const sources = this.ghostPreview.sourceKeys
      .map((key) => this.positions.get(key))
      .filter((position): position is Position => Boolean(position));
    if (!sources.length) return;
    const x =
      sources.reduce((sum, source) => sum + source.x, 0) / sources.length;
    const y =
      sources.reduce((sum, source) => sum + source.y, 0) / sources.length + 75;
    const context = this.context;
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
    context.setLineDash([]);
    context.fillStyle = this.isDarkMode()
      ? "rgba(248,250,252,.94)"
      : "rgba(30,41,59,.9)";
    context.font = "11px sans-serif";
    context.textAlign = "center";
    context.fillText(this.ghostPreview.title.slice(0, 50), x, y + 25);
    context.restore();
  }

  private draw(): void {
    if (this.destroyed) return;
    const context = this.context;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = "rgba(255,255,255,.001)";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.translate(this.transform.x, this.transform.y);
    context.scale(this.transform.scale, this.transform.scale);
    const nodes = this.visibleNodes();
    const sizeDomain =
      this.layout.nodeSizeMetric === "uniform"
        ? null
        : metricExtent(nodes, this.layout.nodeSizeMetric);
    const colorDomain = isMetricID(this.layout.nodeColorMetric)
      ? metricExtent(nodes, this.layout.nodeColorMetric)
      : null;
    const radii = new Map(
      nodes.map((node) => [node.key, this.nodeRadius(node, sizeDomain)]),
    );
    const selectedKey = this.selectedKey;
    const edges = [...this.visibleEdges()].sort((left, right) => {
      const a =
        selectedKey !== null &&
        (left.source === selectedKey || left.target === selectedKey);
      const b =
        selectedKey !== null &&
        (right.source === selectedKey || right.target === selectedKey);
      return Number(a) - Number(b);
    });
    for (const edge of edges) {
      const source = this.positions.get(edge.source);
      const target = this.positions.get(edge.target);
      if (!source || !target) continue;
      const connection =
        selectedKey === null
          ? null
          : edge.target === selectedKey
            ? "citation"
            : edge.source === selectedKey
              ? "reference"
              : null;
      this.drawArrow(
        source,
        target,
        radii.get(edge.target) ?? 7,
        connection,
        selectedKey !== null && connection === null,
      );
    }
    for (const node of nodes) {
      const position = this.positions.get(node.key);
      if (!position) continue;
      this.drawNode(
        node,
        position,
        radii.get(node.key) ?? 7,
        this.nodeColors(node, colorDomain),
      );
    }
    this.drawLabels(nodes, radii);
    this.drawLegend(colorDomain);
    this.drawGhost();
    context.restore();
    this.drawAxes(nodes);
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
    this.draw();
  }

  public setSearchMatches(keys: Set<string> | null): void {
    this.searchMatches = keys ? new Set(keys) : null;
    this.draw();
  }

  public clearSelection(): void {
    if (this.selectedKey === null) return;
    this.selectedKey = null;
    this.onSelectionChange(null);
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

  public resizeViewport = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = this.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.draw();
    }
  };

  public zoomBy(factor: number): void {
    this.markViewAdjusted();
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
    this.markViewAdjusted();
    this.resizeViewport();
    const nodes = this.visibleNodes();
    const positions = nodes
      .map((node) => this.positions.get(node.key))
      .filter((position): position is Position => Boolean(position));
    if (!positions.length) {
      this.transform = { x: 0, y: 0, scale: 1 };
      this.draw();
      return;
    }
    const xCoordinates = positions.map((position) => position.x);
    const yCoordinates = positions.map((position) => position.y);
    if (this.layout.xMetric !== "free") {
      xCoordinates.push(PLOT_LEFT, PLOT_RIGHT);
    }
    if (this.layout.yMetric !== "free") {
      yCoordinates.push(PLOT_TOP, PLOT_BOTTOM);
    }
    const minX = Math.min(...xCoordinates) - MAX_NODE_RADIUS - 45;
    const maxX = Math.max(...xCoordinates) + MAX_NODE_RADIUS + 140;
    const minY = Math.min(...yCoordinates) - MAX_NODE_RADIUS - 35;
    const maxY = Math.max(...yCoordinates) + MAX_NODE_RADIUS + 45;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = clamp(
      Math.min(
        (this.canvas.width - 110) / width,
        (this.canvas.height - 90) / height,
      ),
      0.15,
      5,
    );
    this.transform.scale = scale;
    this.transform.x = (this.canvas.width - (minX + maxX) * scale) / 2;
    this.transform.y = (this.canvas.height - (minY + maxY) * scale) / 2;
    this.draw();
  }

  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.initialFitFrame !== null) {
      this.canvas.ownerDocument.defaultView?.cancelAnimationFrame(
        this.initialFitFrame,
      );
      this.initialFitFrame = null;
    }
    this.resizeObserver?.disconnect();
    this.colorSchemeQuery?.removeEventListener?.(
      "change",
      this.onColorSchemeChange,
    );
    this.colorSchemeQuery = null;
    const view = this.canvas.ownerDocument.defaultView;
    view?.removeEventListener("resize", this.resizeViewport);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
  }
}
