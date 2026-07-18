/// <reference lib="dom" />

import type {
  CitationGraphEdge,
  CitationGraphModel,
  CitationGraphNode,
  GraphAxisMetric,
  GraphLayoutOptions,
  GraphNodeLabelMode,
  GraphNodeSizeMetric,
  GraphScaleType,
} from "../domain/graphTypes";
import {
  formatGraphMetricValue,
  graphMetricAllowsNegative,
  graphMetricIsBoolean,
  graphMetricValue,
} from "./graphMetricDefinitions";

interface LayoutNode extends CitationGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pinnedX: boolean;
  pinnedY: boolean;
  axisTargetX: number | null;
  axisTargetY: number | null;
  axisBandX: number;
  axisBandY: number;
}

interface LayoutEdge {
  source: LayoutNode;
  target: LayoutNode;
  edge: CitationGraphEdge;
}

interface AxisDomain {
  metric: GraphAxisMetric;
  scale: GraphScaleType;
  minimum: number;
  maximum: number;
  transformedMinimum: number;
  transformedMaximum: number;
}

interface AxisRange {
  minimum: number;
  maximum: number;
  missing: number;
}

export interface CitationGraphRendererOptions {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  xAxisCanvas: HTMLCanvasElement;
  yAxisCanvas: HTMLCanvasElement;
  tooltip: HTMLElement;
  model: CitationGraphModel;
  nodeSizeMetric: GraphNodeSizeMetric;
  nodeLabelMode: GraphNodeLabelMode;
  collectionColorByNodeKey: ReadonlyMap<string, string>;
  collectionLabelByNodeKey: ReadonlyMap<string, string>;
  onSelectionChange: (node: CitationGraphNode | null) => void;
  onOpenNode: (node: CitationGraphNode) => void | Promise<void>;
}

export interface CitationGraphGhostPreview {
  key: string;
  title: string;
  year: number | null;
  citationCount: number | null;
  referenceCount: number | null;
  sourceKeys: string[];
}

const DEFAULT_LAYOUT: GraphLayoutOptions = {
  xMetric: "none",
  xScale: "linear",
  yMetric: "none",
  yScale: "linear",
};

const DEFAULT_X_SPAN = 1040;
const DEFAULT_Y_SPAN = 640;
const AXIS_MISSING_GAP = 90;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(key: string, salt: number): number {
  return ((hashString(`${key}:${salt}`) % 100000) + 0.5) / 100000;
}

function transformMetric(value: number, scale: GraphScaleType): number {
  if (scale === "log") {
    return value >= 0 ? Math.log1p(value) : -Math.log1p(Math.abs(value));
  }
  return value;
}

function inverseTransformMetric(value: number, scale: GraphScaleType): number {
  if (scale === "log") {
    return value >= 0 ? Math.expm1(value) : -Math.expm1(-value);
  }
  return value;
}

function createAxisDomain(
  nodes: LayoutNode[],
  metric: GraphAxisMetric,
  scale: GraphScaleType,
): AxisDomain | null {
  if (metric === "none") {
    return null;
  }

  const values = nodes
    .map((node) => graphMetricValue(node, metric))
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );

  if (values.length === 0) {
    return {
      metric,
      scale,
      minimum: 0,
      maximum: 1,
      transformedMinimum: 0,
      transformedMaximum: 1,
    };
  }

  const dataMinimum = Math.min(...values);
  const dataMaximum = Math.max(...values);
  const dataSpan = Math.max(0, dataMaximum - dataMinimum);

  // Keep metric axes bounded to the visible data. A small amount of padding
  // prevents the outermost nodes from sitting directly on the frame without
  // extending the axis into values that do not exist in the current graph.
  let minimum: number;
  let maximum: number;
  if (metric === "year") {
    const padding = Math.max(1, dataSpan * 0.04);
    minimum = Math.floor(dataMinimum - padding);
    maximum = Math.ceil(dataMaximum + padding);
  } else if (graphMetricIsBoolean(metric)) {
    minimum = 0;
    maximum = 1;
  } else {
    const padding = Math.max(dataSpan * 0.05, dataSpan === 0 ? 0.05 : 0);
    minimum = graphMetricAllowsNegative(metric)
      ? dataMinimum - padding
      : Math.max(0, dataMinimum - padding);
    maximum = dataMaximum + padding;
  }
  if (maximum <= minimum) {
    maximum = minimum + 1;
  }

  const transformedMinimum = transformMetric(minimum, scale);
  const transformedMaximum = transformMetric(maximum, scale);

  return {
    metric,
    scale,
    minimum,
    maximum,
    transformedMinimum,
    transformedMaximum:
      transformedMaximum === transformedMinimum
        ? transformedMinimum + 1
        : transformedMaximum,
  };
}

function axisPositionForValue(
  value: number | null,
  domain: AxisDomain | null,
  minimum: number,
  maximum: number,
  missing: number,
  invert = false,
): number | null {
  if (!domain) {
    return null;
  }

  if (value === null || !Number.isFinite(value)) {
    return missing;
  }

  const transformed = transformMetric(value, domain.scale);
  let ratio =
    (transformed - domain.transformedMinimum) /
    (domain.transformedMaximum - domain.transformedMinimum);
  ratio = clamp(ratio, 0, 1);
  if (invert) {
    ratio = 1 - ratio;
  }
  return minimum + ratio * (maximum - minimum);
}

function axisPosition(
  node: LayoutNode,
  domain: AxisDomain | null,
  minimum: number,
  maximum: number,
  missing: number,
  invert = false,
): number | null {
  return axisPositionForValue(
    domain ? graphMetricValue(node, domain.metric) : null,
    domain,
    minimum,
    maximum,
    missing,
    invert,
  );
}

function axisValueAtRatio(domain: AxisDomain, ratio: number): number {
  const transformed =
    domain.transformedMinimum +
    ratio * (domain.transformedMaximum - domain.transformedMinimum);
  return inverseTransformMetric(transformed, domain.scale);
}

function createAxisRange(orientation: "x" | "y"): AxisRange {
  const span = orientation === "x" ? DEFAULT_X_SPAN : DEFAULT_Y_SPAN;
  return {
    minimum: -span / 2,
    maximum: span / 2,
    missing:
      orientation === "x"
        ? -span / 2 - AXIS_MISSING_GAP
        : span / 2 + AXIS_MISSING_GAP,
  };
}

function escapeTooltipText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export class CitationGraphRenderer {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly xAxisCanvas: HTMLCanvasElement;
  private readonly yAxisCanvas: HTMLCanvasElement;
  private readonly tooltip: HTMLElement;
  private readonly collectionColorByNodeKey: ReadonlyMap<string, string>;
  private readonly collectionLabelByNodeKey: ReadonlyMap<string, string>;
  private readonly context: CanvasRenderingContext2D;
  private readonly xAxisContext: CanvasRenderingContext2D;
  private readonly yAxisContext: CanvasRenderingContext2D;
  private readonly window: Window;
  private readonly options: CitationGraphRendererOptions;

  private readonly nodes: LayoutNode[];
  private readonly nodeByKey: Map<string, LayoutNode>;
  private readonly edges: LayoutEdge[];
  private readonly neighbors = new Map<string, Set<string>>();

  private visibleKeys = new Set<string>();
  private searchMatches: Set<string> | null = null;
  private ghostPreview: CitationGraphGhostPreview | null = null;
  private layout: GraphLayoutOptions = { ...DEFAULT_LAYOUT };
  private nodeSizeMetric: GraphNodeSizeMetric;
  private nodeLabelMode: GraphNodeLabelMode;
  private xDomain: AxisDomain | null = null;
  private yDomain: AxisDomain | null = null;
  private xRange: AxisRange = createAxisRange("x");
  private yRange: AxisRange = createAxisRange("y");

  private selectedKey: string | null = null;
  private hoveredKey: string | null = null;
  private transform = { x: 0, y: 0, scale: 1 };
  private animationFrame: number | null = null;
  private resizeFrame: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastCanvasWidth = 0;
  private lastCanvasHeight = 0;
  private alpha = 0;
  private destroyed = false;

  private pointerMode: "none" | "pan" | "node" = "none";
  private pointerNode: LayoutNode | null = null;
  private pointerStart = { x: 0, y: 0 };
  private transformStart = { x: 0, y: 0 };
  private pointerMoved = false;

  private readonly resizeListener = (): void => {
    this.resizeCanvas();
    this.draw();
  };

  constructor(options: CitationGraphRendererOptions) {
    this.options = options;
    this.root = options.root;
    this.canvas = options.canvas;
    this.xAxisCanvas = options.xAxisCanvas;
    this.yAxisCanvas = options.yAxisCanvas;
    this.tooltip = options.tooltip;
    this.nodeSizeMetric = options.nodeSizeMetric;
    this.nodeLabelMode = options.nodeLabelMode;
    this.collectionColorByNodeKey = options.collectionColorByNodeKey;
    this.collectionLabelByNodeKey = options.collectionLabelByNodeKey;

    const context = this.canvas.getContext("2d");
    if (!context) {
      throw new Error("Citation Map could not create a 2D canvas context.");
    }
    this.context = context;

    const xAxisContext = this.xAxisCanvas.getContext("2d");
    const yAxisContext = this.yAxisCanvas.getContext("2d");
    if (!xAxisContext || !yAxisContext) {
      throw new Error("Citation Map could not create an axis canvas context.");
    }
    this.xAxisContext = xAxisContext;
    this.yAxisContext = yAxisContext;

    const win = this.canvas.ownerDocument.defaultView;
    if (!win) {
      throw new Error("Citation Map canvas has no owner window.");
    }
    this.window = win;

    this.nodes = options.model.nodes.map((node) => ({
      ...node,
      authors: [...node.authors],
      tags: [...node.tags],
      collectionIDs: [...node.collectionIDs],
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 8,
      pinnedX: false,
      pinnedY: false,
      axisTargetX: null,
      axisTargetY: null,
      axisBandX: 0,
      axisBandY: 0,
    }));
    this.nodeByKey = new Map(this.nodes.map((node) => [node.key, node]));
    this.edges = options.model.edges
      .map((edge) => {
        const source = this.nodeByKey.get(edge.source);
        const target = this.nodeByKey.get(edge.target);
        return source && target ? { source, target, edge } : null;
      })
      .filter((edge): edge is LayoutEdge => edge !== null);

    for (const edge of this.edges) {
      const sourceNeighbors =
        this.neighbors.get(edge.source.key) ?? new Set<string>();
      sourceNeighbors.add(edge.target.key);
      this.neighbors.set(edge.source.key, sourceNeighbors);

      const targetNeighbors =
        this.neighbors.get(edge.target.key) ?? new Set<string>();
      targetNeighbors.add(edge.source.key);
      this.neighbors.set(edge.target.key, targetNeighbors);
    }

    this.recalculateRadii();
    this.visibleKeys = new Set(this.nodes.map((node) => node.key));
    this.canvas.tabIndex = 0;
    this.bindEvents();
    this.installResizeObserver();
    this.resizeCanvas();
    this.resetLayout(true);
    this.schedulePostMountLayout();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.animationFrame !== null) {
      this.window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.resizeFrame !== null) {
      this.window.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.window.removeEventListener("resize", this.resizeListener);
    this.hideTooltip();
  }

  setVisibleKeys(keys: Iterable<string>): void {
    this.visibleKeys = new Set(keys);
    if (this.selectedKey && !this.visibleKeys.has(this.selectedKey)) {
      this.selectNode(null);
    }
    this.resetLayout(true);
  }

  setSearchMatches(keys: Iterable<string> | null): void {
    this.searchMatches = keys ? new Set(keys) : null;
    this.draw();
  }

  setGhostPreview(preview: CitationGraphGhostPreview | null): void {
    this.ghostPreview = preview
      ? { ...preview, sourceKeys: [...preview.sourceKeys] }
      : null;
    this.draw();
  }

  setLayout(options: GraphLayoutOptions): void {
    this.layout = { ...options };
    this.resetLayout(true);
  }

  setNodeSizeMetric(metric: GraphNodeSizeMetric): void {
    if (metric === this.nodeSizeMetric) {
      return;
    }
    this.nodeSizeMetric = metric;
    this.recalculateRadii();
    this.resetLayout(true);
  }

  setNodeLabelMode(mode: GraphNodeLabelMode): void {
    if (mode === this.nodeLabelMode) {
      return;
    }
    this.nodeLabelMode = mode;
    this.draw();
  }

  zoomBy(factor: number): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const centerX = width / 2;
    const centerY = height / 2;
    const world = this.screenToWorld(centerX, centerY);
    const nextScale = clamp(this.transform.scale * factor, 0.05, 8);
    this.transform.x = centerX - world.x * nextScale;
    this.transform.y = centerY - world.y * nextScale;
    this.transform.scale = nextScale;
    this.draw();
  }

  private formatAxisValue(domain: AxisDomain, ratio: number): string {
    return formatGraphMetricValue(
      domain.metric,
      axisValueAtRatio(domain, ratio),
    );
  }

  private axisTickRatios(domain: AxisDomain, suggestedCount: number): number[] {
    if (graphMetricIsBoolean(domain.metric)) {
      return [0, 1];
    }
    const count = Math.max(2, suggestedCount);
    return Array.from({ length: count + 1 }, (_value, index) => index / count);
  }

  private getAxisInsets(): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } {
    const context = this.context;
    context.save();
    context.font = "10px system-ui, sans-serif";

    let left = 14;
    if (this.yDomain) {
      let widest = 0;
      for (const ratio of this.axisTickRatios(this.yDomain, 6)) {
        widest = Math.max(
          widest,
          context.measureText(this.formatAxisValue(this.yDomain, ratio)).width,
        );
      }
      left = Math.ceil(widest) + 15;
    }

    context.restore();
    return {
      left,
      right: 14,
      top: 14,
      bottom: this.xDomain ? 23 : 14,
    };
  }

  fitView(): void {
    const visible = this.getVisibleNodes();
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;

    if (visible.length === 0 || width <= 0 || height <= 0) {
      this.transform = { x: width / 2, y: height / 2, scale: 1 };
      this.draw();
      return;
    }

    let minimumX = Infinity;
    let maximumX = -Infinity;
    let minimumY = Infinity;
    let maximumY = -Infinity;

    for (const node of visible) {
      minimumX = Math.min(minimumX, node.x - node.radius);
      maximumX = Math.max(maximumX, node.x + node.radius);
      minimumY = Math.min(minimumY, node.y - node.radius);
      maximumY = Math.max(maximumY, node.y + node.radius);
    }

    // A fixed metric axis should use the complete metric range, not merely the
    // outermost node radii. This makes the first and last ticks reach the full
    // plot width/height after fitting. Include the explicit missing-value lane
    // when it is actually occupied.
    if (this.xDomain) {
      const hasMissingX = visible.some(
        (node) => graphMetricValue(node, this.xDomain!.metric) === null,
      );
      minimumX = hasMissingX
        ? Math.min(this.xRange.minimum, this.xRange.missing)
        : this.xRange.minimum;
      maximumX = this.xRange.maximum;
    }
    if (this.yDomain) {
      const hasMissingY = visible.some(
        (node) => graphMetricValue(node, this.yDomain!.metric) === null,
      );
      minimumY = this.yRange.minimum;
      maximumY = hasMissingY
        ? Math.max(this.yRange.maximum, this.yRange.missing)
        : this.yRange.maximum;
    }

    const contentWidth = Math.max(100, maximumX - minimumX);
    const contentHeight = Math.max(100, maximumY - minimumY);
    const insets = this.getAxisInsets();
    const plotWidth = Math.max(80, width - insets.left - insets.right);
    const plotHeight = Math.max(80, height - insets.top - insets.bottom);
    const scale = clamp(
      Math.min(plotWidth / contentWidth, plotHeight / contentHeight),
      0.08,
      2.5,
    );

    this.transform = {
      x: insets.left + plotWidth / 2 - ((minimumX + maximumX) / 2) * scale,
      y: insets.top + plotHeight / 2 - ((minimumY + maximumY) / 2) * scale,
      scale,
    };
    this.draw();
  }

  getVisibleEdgeCount(): number {
    return this.edges.filter(
      (edge) =>
        this.visibleKeys.has(edge.source.key) &&
        this.visibleKeys.has(edge.target.key),
    ).length;
  }

  private recalculateRadii(): void {
    if (this.nodeSizeMetric === "uniform") {
      for (const node of this.nodes) {
        node.radius = 8.5;
      }
      return;
    }

    const values = this.nodes.map((node) =>
      Math.max(
        0,
        this.nodeSizeMetric === "citations"
          ? (node.citationCount ?? 0)
          : (node.referenceCount ?? 0),
      ),
    );
    const transformedMaximum = Math.max(
      0,
      ...values.map((value) => Math.log1p(value)),
    );

    for (let index = 0; index < this.nodes.length; index += 1) {
      const value = values[index];
      const ratio =
        transformedMaximum > 0 ? Math.log1p(value) / transformedMaximum : 0;
      this.nodes[index].radius = 6.5 + Math.sqrt(ratio) * 14.5;
    }
  }

  private getVisibleNodes(): LayoutNode[] {
    return this.nodes.filter((node) => this.visibleKeys.has(node.key));
  }

  private metricGroupKey(node: LayoutNode, domain: AxisDomain | null): string {
    if (!domain) return "free";
    const value = graphMetricValue(node, domain.metric);
    return value === null || !Number.isFinite(value)
      ? "missing"
      : String(value);
  }

  private duplicateBand(
    orientation: "x" | "y",
    groupSize: number,
    uniqueValueCount: number,
  ): number {
    const range = orientation === "x" ? this.xRange : this.yRange;
    const span = range.maximum - range.minimum;
    const nominalInterval =
      uniqueValueCount > 1 ? span / (uniqueValueCount - 1) : span * 0.35;
    const desired = 10 + Math.sqrt(groupSize) * 7;
    return clamp(Math.min(desired, nominalInterval * 0.32), 10, 46);
  }

  /**
   * Assign each fixed-axis node a nominal target and a small value band.
   * Unique values remain mathematically fixed. Duplicate values receive a
   * deterministic offset inside a narrow band, which prevents complete
   * overlap without making a paper appear to belong to a neighbouring value.
   */
  private configureAxisTargets(nodes: LayoutNode[]): void {
    for (const node of nodes) {
      node.axisTargetX = axisPosition(
        node,
        this.xDomain,
        this.xRange.minimum,
        this.xRange.maximum,
        this.xRange.missing,
      );
      node.axisTargetY = axisPosition(
        node,
        this.yDomain,
        this.yRange.minimum,
        this.yRange.maximum,
        this.yRange.missing,
        true,
      );
      node.axisBandX = 0;
      node.axisBandY = 0;
    }

    if (this.xDomain && !this.yDomain) {
      const groups = new Map<string, LayoutNode[]>();
      for (const node of nodes) {
        const key = this.metricGroupKey(node, this.xDomain);
        groups.set(key, [...(groups.get(key) ?? []), node]);
      }
      const uniqueValueCount = groups.size;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        group.sort((left, right) => left.key.localeCompare(right.key));
        const band = this.duplicateBand("x", group.length, uniqueValueCount);
        group.forEach((node, index) => {
          const ratio =
            group.length === 1 ? 0 : index / (group.length - 1) - 0.5;
          node.axisTargetX = (node.axisTargetX ?? 0) + ratio * band * 1.6;
          node.axisBandX = Math.max(4, band * 0.2);
        });
      }
      return;
    }

    if (this.yDomain && !this.xDomain) {
      const groups = new Map<string, LayoutNode[]>();
      for (const node of nodes) {
        const key = this.metricGroupKey(node, this.yDomain);
        groups.set(key, [...(groups.get(key) ?? []), node]);
      }
      const uniqueValueCount = groups.size;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        group.sort((left, right) => left.key.localeCompare(right.key));
        const band = this.duplicateBand("y", group.length, uniqueValueCount);
        group.forEach((node, index) => {
          const ratio =
            group.length === 1 ? 0 : index / (group.length - 1) - 0.5;
          node.axisTargetY = (node.axisTargetY ?? 0) + ratio * band * 1.6;
          node.axisBandY = Math.max(4, band * 0.2);
        });
      }
      return;
    }

    if (this.xDomain && this.yDomain) {
      const groups = new Map<string, LayoutNode[]>();
      for (const node of nodes) {
        const key = `${this.metricGroupKey(node, this.xDomain)}|${this.metricGroupKey(node, this.yDomain)}`;
        groups.set(key, [...(groups.get(key) ?? []), node]);
      }
      const xUnique = new Set(
        nodes.map((node) => this.metricGroupKey(node, this.xDomain)),
      ).size;
      const yUnique = new Set(
        nodes.map((node) => this.metricGroupKey(node, this.yDomain)),
      ).size;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        group.sort((left, right) => left.key.localeCompare(right.key));
        const xBand = this.duplicateBand("x", group.length, xUnique);
        const yBand = this.duplicateBand("y", group.length, yUnique);
        const maximumRadius = Math.max(...group.map((node) => node.radius));
        group.forEach((node, index) => {
          if (index > 0) {
            const angle = index * 2.399963229728653;
            const radial = Math.min(
              Math.min(xBand, yBand),
              (maximumRadius + 5) * Math.sqrt(index),
            );
            node.axisTargetX =
              (node.axisTargetX ?? 0) + Math.cos(angle) * radial;
            node.axisTargetY =
              (node.axisTargetY ?? 0) + Math.sin(angle) * radial;
          }
          node.axisBandX = Math.max(4, xBand * 0.18);
          node.axisBandY = Math.max(4, yBand * 0.18);
        });
      }
    }
  }

  private resetLayout(fitAfterSettle: boolean): void {
    const visible = this.getVisibleNodes();
    this.xDomain = createAxisDomain(
      visible,
      this.layout.xMetric,
      this.layout.xScale,
    );
    this.yDomain = createAxisDomain(
      visible,
      this.layout.yMetric,
      this.layout.yScale,
    );
    this.xRange = createAxisRange("x");
    this.yRange = createAxisRange("y");
    this.configureAxisTargets(visible);

    const nodeCount = Math.max(visible.length, 1);
    const radius = Math.max(120, Math.sqrt(nodeCount) * 36);

    for (let index = 0; index < visible.length; index += 1) {
      const node = visible[index];
      node.pinnedX = false;
      node.pinnedY = false;
      node.vx = 0;
      node.vy = 0;

      const xTarget = node.axisTargetX;
      const yTarget = node.axisTargetY;

      if (xTarget !== null) {
        node.x = xTarget;
      } else {
        const angle = index * 2.399963229728653 + seededUnit(node.key, 2);
        node.x = Math.cos(angle) * radius * Math.sqrt((index + 1) / nodeCount);
      }

      if (yTarget !== null) {
        node.y = yTarget;
      } else {
        const angle = index * 2.399963229728653 + seededUnit(node.key, 4);
        node.y = Math.sin(angle) * radius * Math.sqrt((index + 1) / nodeCount);
      }
    }

    this.alpha = 1;
    const iterations =
      visible.length > 900 ? 45 : visible.length > 400 ? 70 : 110;
    for (let index = 0; index < iterations; index += 1) {
      this.stepSimulation(Math.max(0.08, 1 - index / iterations));
    }

    if (fitAfterSettle) {
      this.fitView();
    }
    this.startAnimation();
  }

  private startAnimation(): void {
    if (this.destroyed || this.animationFrame !== null) {
      return;
    }

    const animate = (): void => {
      this.animationFrame = null;
      if (this.destroyed) {
        return;
      }

      if (this.alpha > 0.01) {
        this.stepSimulation(this.alpha);
        this.alpha *= 0.93;
        this.draw();
        this.animationFrame = this.window.requestAnimationFrame(animate);
      } else {
        this.draw();
      }
    };

    this.animationFrame = this.window.requestAnimationFrame(animate);
  }

  private stepSimulation(alpha: number): void {
    const nodes = this.getVisibleNodes();
    if (nodes.length === 0) {
      return;
    }

    for (const edge of this.edges) {
      if (
        !this.visibleKeys.has(edge.source.key) ||
        !this.visibleKeys.has(edge.target.key)
      ) {
        continue;
      }

      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = 85 + edge.source.radius + edge.target.radius;
      const strength = (distance - desired) * 0.0019 * alpha;
      const fx = (dx / distance) * strength;
      const fy = (dy / distance) * strength;

      if (this.canMoveX(edge.source)) edge.source.vx += fx;
      if (this.canMoveY(edge.source)) edge.source.vy += fy;
      if (this.canMoveX(edge.target)) edge.target.vx -= fx;
      if (this.canMoveY(edge.target)) edge.target.vy -= fy;
    }

    if (nodes.length <= 360) {
      for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        const left = nodes[leftIndex];
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < nodes.length;
          rightIndex += 1
        ) {
          const right = nodes[rightIndex];
          let dx = right.x - left.x;
          let dy = right.y - left.y;
          let distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < 0.01) {
            dx = seededUnit(`${left.key}:${right.key}`, 8) - 0.5;
            dy = seededUnit(`${right.key}:${left.key}`, 9) - 0.5;
            distanceSquared = dx * dx + dy * dy;
          }

          const distance = Math.sqrt(distanceSquared);
          const repulsion = Math.min(0.85, (1500 * alpha) / distanceSquared);
          const fx = (dx / distance) * repulsion;
          const fy = (dy / distance) * repulsion;

          if (this.canMoveX(left)) left.vx -= fx;
          if (this.canMoveY(left)) left.vy -= fy;
          if (this.canMoveX(right)) right.vx += fx;
          if (this.canMoveY(right)) right.vy += fy;
        }
      }
    }

    for (const node of nodes) {
      const xTarget = node.axisTargetX;
      const yTarget = node.axisTargetY;

      if (xTarget !== null) {
        if (node.axisBandX > 0 && !node.pinnedX) {
          node.vx += (xTarget - node.x) * 0.055 * alpha;
        } else {
          node.x = xTarget;
          node.vx = 0;
        }
      } else if (this.canMoveX(node)) {
        node.vx += -node.x * 0.0009 * alpha;
      } else {
        node.vx = 0;
      }

      if (yTarget !== null) {
        if (node.axisBandY > 0 && !node.pinnedY) {
          node.vy += (yTarget - node.y) * 0.055 * alpha;
        } else {
          node.y = yTarget;
          node.vy = 0;
        }
      } else if (this.canMoveY(node)) {
        node.vy += -node.y * 0.0009 * alpha;
      } else {
        node.vy = 0;
      }
    }

    this.applyCollisions(nodes, alpha);

    for (const node of nodes) {
      if (this.canMoveX(node)) {
        node.vx = clamp(node.vx * 0.78, -14, 14);
        node.x += node.vx;
        if (node.axisTargetX !== null && node.axisBandX > 0) {
          node.x = clamp(
            node.x,
            node.axisTargetX - node.axisBandX,
            node.axisTargetX + node.axisBandX,
          );
        }
      } else {
        node.vx = 0;
      }
      if (this.canMoveY(node)) {
        node.vy = clamp(node.vy * 0.78, -14, 14);
        node.y += node.vy;
        if (node.axisTargetY !== null && node.axisBandY > 0) {
          node.y = clamp(
            node.y,
            node.axisTargetY - node.axisBandY,
            node.axisTargetY + node.axisBandY,
          );
        }
      } else {
        node.vy = 0;
      }
    }
  }

  private canMoveX(node: LayoutNode): boolean {
    return (
      !node.pinnedX && (this.layout.xMetric === "none" || node.axisBandX > 0)
    );
  }

  private canMoveY(node: LayoutNode): boolean {
    return (
      !node.pinnedY && (this.layout.yMetric === "none" || node.axisBandY > 0)
    );
  }

  private applyCollisions(nodes: LayoutNode[], alpha: number): void {
    const cellSize = 52;
    const cells = new Map<string, LayoutNode[]>();

    for (const node of nodes) {
      const cellX = Math.floor(node.x / cellSize);
      const cellY = Math.floor(node.y / cellSize);
      const key = `${cellX}:${cellY}`;
      const cell = cells.get(key) ?? [];
      cell.push(node);
      cells.set(key, cell);
    }

    const visited = new Set<string>();
    for (const [key, cell] of cells) {
      const [cellX, cellY] = key.split(":").map(Number);
      for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
        for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
          const otherKey = `${cellX + xOffset}:${cellY + yOffset}`;
          const other = cells.get(otherKey);
          if (!other) {
            continue;
          }

          for (const left of cell) {
            for (const right of other) {
              if (left === right) {
                continue;
              }
              const pairKey =
                left.key < right.key
                  ? `${left.key}|${right.key}`
                  : `${right.key}|${left.key}`;
              if (visited.has(pairKey)) {
                continue;
              }
              visited.add(pairKey);

              let dx = right.x - left.x;
              let dy = right.y - left.y;
              let distance = Math.hypot(dx, dy);
              const minimumDistance = left.radius + right.radius + 5;
              if (distance >= minimumDistance) {
                continue;
              }
              if (distance < 0.01) {
                dx = seededUnit(pairKey, 11) - 0.5;
                dy = seededUnit(pairKey, 12) - 0.5;
                distance = Math.max(0.01, Math.hypot(dx, dy));
              }

              const push =
                ((minimumDistance - distance) / distance) * 0.16 * alpha;
              const fx = dx * push;
              const fy = dy * push;
              if (this.canMoveX(left)) left.vx -= fx;
              if (this.canMoveY(left)) left.vy -= fy;
              if (this.canMoveX(right)) right.vx += fx;
              if (this.canMoveY(right)) right.vy += fy;
            }
          }
        }
      }
    }
  }

  private installResizeObserver(): void {
    const ResizeObserverConstructor = (
      this.window as Window & {
        ResizeObserver?: typeof ResizeObserver;
      }
    ).ResizeObserver;
    if (!ResizeObserverConstructor) {
      return;
    }

    const observer = new ResizeObserverConstructor(() => {
      this.scheduleCanvasResize();
    });
    observer.observe(this.canvas.parentElement ?? this.canvas);
    this.resizeObserver = observer;
  }

  private scheduleCanvasResize(): void {
    if (this.destroyed || this.resizeFrame !== null) {
      return;
    }

    this.resizeFrame = this.window.requestAnimationFrame(() => {
      this.resizeFrame = null;
      const width = this.canvas.clientWidth;
      const height = this.canvas.clientHeight;
      if (width <= 1 || height <= 1) {
        return;
      }

      const firstVisibleSize =
        this.lastCanvasWidth <= 1 || this.lastCanvasHeight <= 1;
      const sizeChanged =
        width !== this.lastCanvasWidth || height !== this.lastCanvasHeight;
      this.lastCanvasWidth = width;
      this.lastCanvasHeight = height;

      if (!sizeChanged) {
        return;
      }

      this.resizeCanvas();
      if (firstVisibleSize) {
        this.resetLayout(true);
      } else {
        this.draw();
      }
    });
  }

  private schedulePostMountLayout(): void {
    const retry = (remaining: number): void => {
      if (this.destroyed) {
        return;
      }

      this.window.requestAnimationFrame(() => {
        if (this.destroyed) {
          return;
        }

        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        if (width > 1 && height > 1) {
          this.lastCanvasWidth = width;
          this.lastCanvasHeight = height;
          this.resizeCanvas();
          this.resetLayout(true);
          return;
        }

        if (remaining > 0) {
          this.window.setTimeout(() => retry(remaining - 1), 50);
        }
      });
    };

    retry(8);
  }

  private resizeCanvas(): void {
    this.resizeCanvasElement(this.canvas);
    this.resizeCanvasElement(this.xAxisCanvas);
    this.resizeCanvasElement(this.yAxisCanvas);
  }

  private resizeCanvasElement(canvas: HTMLCanvasElement): void {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const pixelRatio = Math.max(1, this.window.devicePixelRatio || 1);
    const targetWidth = Math.round(width * pixelRatio);
    const targetHeight = Math.round(height * pixelRatio);

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
  }

  private getColors(): Record<string, string> {
    const style = this.window.getComputedStyle?.(this.root) ?? null;
    const read = (name: string, fallback: string): string =>
      style?.getPropertyValue(name).trim() || fallback;

    return {
      text: read("--cm-text-primary", "rgba(0,0,0,.85)"),
      secondary: read("--cm-text-secondary", "rgba(0,0,0,.55)"),
      tertiary: read("--cm-text-tertiary", "rgba(0,0,0,.35)"),
      border: read("--cm-border", "rgba(0,0,0,.15)"),
      accent: read("--cm-accent", "#4072e5"),
      node: read("--cm-node", "#4c7fdc"),
      unresolved: read("--cm-node-unresolved", "#8b8f98"),
      selected: read("--cm-node-selected", "#d97706"),
      edge: read("--cm-edge", "rgba(80,90,110,.38)"),
      edgeHighlight: read("--cm-edge-highlight", "#d97706"),
      background: read("--cm-surface", "#ffffff"),
    };
  }

  private draw(): void {
    if (this.destroyed) {
      return;
    }

    this.updateAxisGutterSizes();
    this.resizeCanvas();
    const context = this.context;
    const pixelRatio = Math.max(1, this.window.devicePixelRatio || 1);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const colors = this.getColors();

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(this.transform.x, this.transform.y);
    context.scale(this.transform.scale, this.transform.scale);

    this.drawEdges(context, colors);
    this.drawGhostEdges(context, colors);
    this.drawNodes(context, colors);
    this.drawGhostNode(context, colors);

    context.restore();
    this.drawAxesOnGraph(context, colors, width, height);
  }

  private updateAxisGutterSizes(): void {
    // Axis ticks and values are drawn directly on the graph canvas. Keeping
    // the legacy dock rows at zero avoids the layout race that previously
    // produced zero-sized axis canvases in Zotero's XUL documents.
    this.root.style.setProperty("--cm-y-axis-gutter", "0px");
    this.root.style.setProperty("--cm-x-axis-gutter", "0px");
  }

  private drawAxesOnGraph(
    context: CanvasRenderingContext2D,
    colors: Record<string, string>,
    width: number,
    height: number,
  ): void {
    const pixelRatio = Math.max(1, this.window.devicePixelRatio || 1);
    const insets = this.getAxisInsets();

    context.save();
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.font = "10px system-ui, sans-serif";
    context.fillStyle = colors.text;
    context.strokeStyle = colors.secondary;
    context.lineWidth = 1;

    if (this.xDomain) {
      context.textAlign = "center";
      context.textBaseline = "bottom";
      const tickTop = height - 18;
      const tickBottom = height - 13;
      const labelY = height - 1;
      const tickCount = Math.max(2, Math.min(8, Math.floor(width / 110)));

      for (const ratio of this.axisTickRatios(this.xDomain, tickCount)) {
        const worldX =
          this.xRange.minimum +
          ratio * (this.xRange.maximum - this.xRange.minimum);
        const x = this.transform.x + worldX * this.transform.scale;
        if (x < insets.left - 1 || x > width - insets.right + 1) {
          continue;
        }

        context.beginPath();
        context.moveTo(Math.round(x) + 0.5, tickTop);
        context.lineTo(Math.round(x) + 0.5, tickBottom);
        context.stroke();
        context.fillText(this.formatAxisValue(this.xDomain, ratio), x, labelY);
      }
    }

    if (this.yDomain) {
      context.textAlign = "right";
      context.textBaseline = "middle";
      const labelRight = insets.left - 8;
      const tickLeft = insets.left - 5;
      const tickRight = insets.left;
      const tickCount = Math.max(2, Math.min(8, Math.floor(height / 82)));

      for (const ratio of this.axisTickRatios(this.yDomain, tickCount)) {
        const worldY =
          this.yRange.maximum -
          ratio * (this.yRange.maximum - this.yRange.minimum);
        const y = this.transform.y + worldY * this.transform.scale;
        if (y < insets.top - 1 || y > height - insets.bottom + 1) {
          continue;
        }

        context.beginPath();
        context.moveTo(tickLeft, Math.round(y) + 0.5);
        context.lineTo(tickRight, Math.round(y) + 0.5);
        context.stroke();
        context.fillText(
          this.formatAxisValue(this.yDomain, ratio),
          labelRight,
          y,
        );
      }
    }

    context.restore();

    // Clear legacy dock canvases in case a hot reload left stale pixels there.
    for (const [canvas, axisContext] of [
      [this.xAxisCanvas, this.xAxisContext],
      [this.yAxisCanvas, this.yAxisContext],
    ] as const) {
      const axisWidth = canvas.clientWidth;
      const axisHeight = canvas.clientHeight;
      axisContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      axisContext.clearRect(0, 0, axisWidth, axisHeight);
    }
  }

  private drawEdges(
    context: CanvasRenderingContext2D,
    colors: Record<string, string>,
  ): void {
    const focusKey = this.hoveredKey ?? this.selectedKey;
    const inverseScale = 1 / this.transform.scale;

    for (const edge of this.edges) {
      if (
        !this.visibleKeys.has(edge.source.key) ||
        !this.visibleKeys.has(edge.target.key)
      ) {
        continue;
      }

      const searchDimmed =
        this.searchMatches !== null &&
        !this.searchMatches.has(edge.source.key) &&
        !this.searchMatches.has(edge.target.key);
      const focused =
        focusKey !== null &&
        (edge.source.key === focusKey || edge.target.key === focusKey);
      const focusDimmed = focusKey !== null && !focused;
      const alpha = searchDimmed || focusDimmed ? 0.07 : focused ? 0.92 : 0.32;

      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / distance;
      const uy = dy / distance;
      const startX = edge.source.x + ux * edge.source.radius;
      const startY = edge.source.y + uy * edge.source.radius;
      const endX = edge.target.x - ux * (edge.target.radius + 3 * inverseScale);
      const endY = edge.target.y - uy * (edge.target.radius + 3 * inverseScale);

      context.save();
      context.globalAlpha = alpha;
      context.strokeStyle = focused ? colors.edgeHighlight : colors.edge;
      context.fillStyle = focused ? colors.edgeHighlight : colors.edge;
      context.lineWidth = (focused ? 2.2 : 1.15) * inverseScale;
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.stroke();

      const arrowSize = (focused ? 7 : 5.5) * inverseScale;
      const angle = Math.atan2(dy, dx);
      context.beginPath();
      context.moveTo(endX, endY);
      context.lineTo(
        endX - Math.cos(angle - Math.PI / 6) * arrowSize,
        endY - Math.sin(angle - Math.PI / 6) * arrowSize,
      );
      context.lineTo(
        endX - Math.cos(angle + Math.PI / 6) * arrowSize,
        endY - Math.sin(angle + Math.PI / 6) * arrowSize,
      );
      context.closePath();
      context.fill();
      context.restore();
    }
  }

  private ghostMetricValue(
    preview: CitationGraphGhostPreview,
    metric: GraphAxisMetric,
  ): number | null {
    switch (metric) {
      case "none":
        return null;
      case "year":
        return preview.year;
      case "citations":
        return preview.citationCount;
      case "references":
        return preview.referenceCount;
      case "library-coverage":
      case "citation-velocity":
      case "citation-acceleration":
        return null;
    }
  }

  private getGhostPosition(): {
    x: number;
    y: number;
    radius: number;
    sources: LayoutNode[];
  } | null {
    const preview = this.ghostPreview;
    if (!preview) return null;

    const sources = preview.sourceKeys
      .map((key) => this.nodeByKey.get(key))
      .filter(
        (node): node is LayoutNode =>
          node !== undefined && this.visibleKeys.has(node.key),
      );
    if (sources.length === 0) return null;

    const centroidX =
      sources.reduce((sum, node) => sum + node.x, 0) / sources.length;
    const centroidY =
      sources.reduce((sum, node) => sum + node.y, 0) / sources.length;
    const angle = seededUnit(preview.key, 31) * Math.PI * 2;
    const offset = 48 + Math.min(36, Math.sqrt(sources.length) * 8);

    const xValue = this.xDomain
      ? this.ghostMetricValue(preview, this.xDomain.metric)
      : null;
    const yValue = this.yDomain
      ? this.ghostMetricValue(preview, this.yDomain.metric)
      : null;
    const xPosition =
      this.xDomain && xValue !== null
        ? axisPositionForValue(
            xValue,
            this.xDomain,
            this.xRange.minimum,
            this.xRange.maximum,
            this.xRange.missing,
          )
        : null;
    const yPosition =
      this.yDomain && yValue !== null
        ? axisPositionForValue(
            yValue,
            this.yDomain,
            this.yRange.minimum,
            this.yRange.maximum,
            this.yRange.missing,
            true,
          )
        : null;
    const x =
      xPosition ??
      centroidX + (yPosition === null ? Math.cos(angle) * offset : 0);
    const y =
      yPosition ??
      centroidY + (xPosition === null ? Math.sin(angle) * offset : 0);

    return { x, y, radius: 11, sources };
  }

  private drawGhostEdges(
    context: CanvasRenderingContext2D,
    colors: Record<string, string>,
  ): void {
    const ghost = this.getGhostPosition();
    if (!ghost) return;

    const inverseScale = 1 / this.transform.scale;
    for (const source of ghost.sources) {
      const dx = ghost.x - source.x;
      const dy = ghost.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / distance;
      const uy = dy / distance;
      const startX = source.x + ux * source.radius;
      const startY = source.y + uy * source.radius;
      const endX = ghost.x - ux * (ghost.radius + 3 * inverseScale);
      const endY = ghost.y - uy * (ghost.radius + 3 * inverseScale);

      context.save();
      context.globalAlpha = 0.78;
      context.strokeStyle = colors.edgeHighlight;
      context.fillStyle = colors.edgeHighlight;
      context.lineWidth = 1.7 * inverseScale;
      context.setLineDash([6 * inverseScale, 4 * inverseScale]);
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.stroke();
      context.setLineDash([]);

      const arrowSize = 6.5 * inverseScale;
      const angle = Math.atan2(dy, dx);
      context.beginPath();
      context.moveTo(endX, endY);
      context.lineTo(
        endX - Math.cos(angle - Math.PI / 6) * arrowSize,
        endY - Math.sin(angle - Math.PI / 6) * arrowSize,
      );
      context.lineTo(
        endX - Math.cos(angle + Math.PI / 6) * arrowSize,
        endY - Math.sin(angle + Math.PI / 6) * arrowSize,
      );
      context.closePath();
      context.fill();
      context.restore();
    }
  }

  private drawGhostNode(
    context: CanvasRenderingContext2D,
    colors: Record<string, string>,
  ): void {
    const preview = this.ghostPreview;
    const ghost = this.getGhostPosition();
    if (!preview || !ghost) return;

    const inverseScale = 1 / this.transform.scale;
    context.save();
    context.beginPath();
    context.arc(ghost.x, ghost.y, ghost.radius, 0, Math.PI * 2);
    context.fillStyle = colors.background;
    context.globalAlpha = 0.92;
    context.fill();
    context.globalAlpha = 1;
    context.strokeStyle = colors.edgeHighlight;
    context.lineWidth = 2.2 * inverseScale;
    context.setLineDash([4.5 * inverseScale, 3 * inverseScale]);
    context.stroke();
    context.setLineDash([]);

    const maximumLength = 54;
    const label =
      preview.title.length > maximumLength
        ? `${preview.title.slice(0, maximumLength - 1)}…`
        : preview.title;
    const labelX = ghost.x + ghost.radius + 5 * inverseScale;
    context.font = `600 ${12 * inverseScale}px system-ui, sans-serif`;
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 3.5 * inverseScale;
    context.strokeStyle = colors.background;
    context.strokeText(label, labelX, ghost.y);
    context.fillStyle = colors.edgeHighlight;
    context.fillText(label, labelX, ghost.y);
    context.restore();
  }

  private firstAuthorLabel(node: CitationGraphNode): string {
    const author = node.authors[0]?.trim();
    if (!author) {
      return "Unknown author";
    }
    if (author.includes(",")) {
      return author.split(",", 1)[0].trim() || author;
    }
    const parts = author.split(/\s+/).filter(Boolean);
    return parts.at(-1) ?? author;
  }

  private nodeLabel(node: CitationGraphNode): string {
    if (this.nodeLabelMode === "author-year") {
      return `${this.firstAuthorLabel(node)}, ${node.year ?? "n.d."}`;
    }
    return node.title;
  }

  private drawNodes(
    context: CanvasRenderingContext2D,
    colors: Record<string, string>,
  ): void {
    const visible = this.getVisibleNodes();
    const focusKey = this.hoveredKey ?? this.selectedKey;
    const focusNeighbors = focusKey ? this.neighbors.get(focusKey) : null;
    const inverseScale = 1 / this.transform.scale;

    for (const node of visible) {
      const searchDimmed =
        this.searchMatches !== null && !this.searchMatches.has(node.key);
      const focusDimmed =
        focusKey !== null &&
        node.key !== focusKey &&
        !focusNeighbors?.has(node.key);
      const alpha = searchDimmed || focusDimmed ? 0.14 : 1;
      const selected = node.key === this.selectedKey;
      const hovered = node.key === this.hoveredKey;

      const collectionColor =
        this.collectionColorByNodeKey.get(node.key) ?? colors.node;

      context.save();
      context.globalAlpha =
        alpha * (node.metricStatus === "success" ? 1 : 0.48);
      context.beginPath();
      context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      context.fillStyle = collectionColor;
      context.fill();
      context.globalAlpha = alpha;
      context.lineWidth = (selected || hovered ? 3 : 1.2) * inverseScale;
      context.strokeStyle =
        selected || hovered
          ? colors.selected
          : node.metricStatus === "success"
            ? colors.background
            : colors.unresolved;
      if (node.metricStatus !== "success" && !selected && !hovered) {
        context.setLineDash([3.5 * inverseScale, 2.5 * inverseScale]);
      }
      context.stroke();

      if (node.incomingLibraryCitations > 0) {
        context.beginPath();
        context.arc(
          node.x,
          node.y,
          Math.max(1.8 * inverseScale, node.radius * 0.28),
          0,
          Math.PI * 2,
        );
        context.fillStyle = colors.background;
        context.globalAlpha = alpha * 0.9;
        context.fill();
      }
      context.restore();
    }

    const prioritized = [...visible].sort(
      (left, right) =>
        Number(
          right.key === this.selectedKey || right.key === this.hoveredKey,
        ) -
          Number(
            left.key === this.selectedKey || left.key === this.hoveredKey,
          ) ||
        right.incomingLibraryCitations - left.incomingLibraryCitations ||
        (right.citationCount ?? -1) - (left.citationCount ?? -1),
    );

    const showAllLabels =
      visible.length <= 80 ||
      this.transform.scale >= 0.72 ||
      (this.searchMatches !== null && this.searchMatches.size <= 40);
    const labelCandidates = showAllLabels
      ? prioritized
      : prioritized.slice(
          0,
          Math.min(
            visible.length,
            Math.max(20, Math.ceil(80 / Math.max(this.transform.scale, 0.2))),
          ),
        );

    const labelled = new Set<string>();
    context.save();
    context.font = `600 ${12 * inverseScale}px system-ui, sans-serif`;
    context.textBaseline = "middle";
    context.lineJoin = "round";

    for (const node of labelCandidates) {
      if (labelled.has(node.key) || !this.visibleKeys.has(node.key)) {
        continue;
      }
      labelled.add(node.key);

      const searchDimmed =
        this.searchMatches !== null && !this.searchMatches.has(node.key);
      if (searchDimmed) {
        continue;
      }

      const rawLabel = this.nodeLabel(node);
      const emphasized =
        node.key === this.selectedKey || node.key === this.hoveredKey;
      const maxLength = emphasized
        ? 72
        : this.nodeLabelMode === "title"
          ? 42
          : 30;
      const label =
        rawLabel.length > maxLength
          ? `${rawLabel.slice(0, maxLength - 1)}…`
          : rawLabel;
      const labelX = node.x + node.radius + 5 * inverseScale;
      context.globalAlpha = emphasized ? 1 : 0.84;
      context.lineWidth = 3.5 * inverseScale;
      context.strokeStyle = colors.background;
      context.strokeText(label, labelX, node.y);
      context.fillStyle = colors.text;
      context.fillText(label, labelX, node.y);
    }
    context.restore();
  }

  private bindEvents(): void {
    this.window.addEventListener("resize", this.resizeListener);

    this.canvas.addEventListener(
      "wheel",
      (event: WheelEvent) => {
        event.preventDefault();
        const point = this.pointerPosition(event);
        const world = this.screenToWorld(point.x, point.y);
        const factor = Math.exp(-event.deltaY * 0.0014);
        const nextScale = clamp(this.transform.scale * factor, 0.05, 8);
        this.transform.x = point.x - world.x * nextScale;
        this.transform.y = point.y - world.y * nextScale;
        this.transform.scale = nextScale;
        this.draw();
      },
      { passive: false },
    );

    this.canvas.addEventListener("pointerdown", (event: PointerEvent) => {
      this.canvas.focus();
      this.canvas.setPointerCapture(event.pointerId);
      const point = this.pointerPosition(event);
      const node = this.hitTest(point.x, point.y);
      this.pointerStart = point;
      this.transformStart = { x: this.transform.x, y: this.transform.y };
      this.pointerMoved = false;

      if (node) {
        this.pointerMode = "node";
        this.pointerNode = node;
      } else {
        this.pointerMode = "pan";
        this.pointerNode = null;
      }
    });

    this.canvas.addEventListener("pointermove", (event: PointerEvent) => {
      const point = this.pointerPosition(event);
      const movedDistance = Math.hypot(
        point.x - this.pointerStart.x,
        point.y - this.pointerStart.y,
      );
      const draggedNodeCanMove =
        this.pointerMode !== "node" ||
        this.layout.xMetric === "none" ||
        this.layout.yMetric === "none" ||
        Boolean(this.pointerNode?.axisBandX) ||
        Boolean(this.pointerNode?.axisBandY);
      if (movedDistance > 3 && draggedNodeCanMove) {
        this.pointerMoved = true;
      }

      if (this.pointerMode === "pan") {
        this.transform.x =
          this.transformStart.x + point.x - this.pointerStart.x;
        this.transform.y =
          this.transformStart.y + point.y - this.pointerStart.y;
        this.draw();
        return;
      }

      if (this.pointerMode === "node" && this.pointerNode) {
        const world = this.screenToWorld(point.x, point.y);
        if (this.layout.xMetric === "none") {
          this.pointerNode.x = world.x;
          this.pointerNode.vx = 0;
          this.pointerNode.pinnedX = true;
        } else if (
          this.pointerNode.axisTargetX !== null &&
          this.pointerNode.axisBandX > 0
        ) {
          this.pointerNode.x = clamp(
            world.x,
            this.pointerNode.axisTargetX - this.pointerNode.axisBandX,
            this.pointerNode.axisTargetX + this.pointerNode.axisBandX,
          );
          this.pointerNode.vx = 0;
          this.pointerNode.pinnedX = true;
        } else if (this.pointerNode.axisTargetX !== null) {
          this.pointerNode.x = this.pointerNode.axisTargetX;
        }
        if (this.layout.yMetric === "none") {
          this.pointerNode.y = world.y;
          this.pointerNode.vy = 0;
          this.pointerNode.pinnedY = true;
        } else if (
          this.pointerNode.axisTargetY !== null &&
          this.pointerNode.axisBandY > 0
        ) {
          this.pointerNode.y = clamp(
            world.y,
            this.pointerNode.axisTargetY - this.pointerNode.axisBandY,
            this.pointerNode.axisTargetY + this.pointerNode.axisBandY,
          );
          this.pointerNode.vy = 0;
          this.pointerNode.pinnedY = true;
        } else if (this.pointerNode.axisTargetY !== null) {
          this.pointerNode.y = this.pointerNode.axisTargetY;
        }
        this.draw();
        return;
      }

      const hovered = this.hitTest(point.x, point.y);
      const nextKey = hovered?.key ?? null;
      if (nextKey !== this.hoveredKey) {
        this.hoveredKey = nextKey;
        this.draw();
      }
      if (hovered) {
        this.showTooltip(hovered, point.x, point.y);
      } else {
        this.hideTooltip();
      }
    });

    const finishPointer = (event: PointerEvent): void => {
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      const point = this.pointerPosition(event);
      const clicked = this.hitTest(point.x, point.y);

      if (!this.pointerMoved) {
        this.selectNode(clicked);
      }

      this.pointerMode = "none";
      this.pointerNode = null;
    };

    this.canvas.addEventListener("pointerup", finishPointer);
    this.canvas.addEventListener("pointercancel", finishPointer);
    this.canvas.addEventListener("pointerleave", () => {
      if (this.pointerMode === "none") {
        this.hoveredKey = null;
        this.hideTooltip();
        this.draw();
      }
    });

    this.canvas.addEventListener("dblclick", (event: MouseEvent) => {
      const point = this.pointerPosition(event);
      const node = this.hitTest(point.x, point.y);
      if (node) {
        void this.options.onOpenNode(node);
      }
    });

    this.canvas.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        this.fitView();
      } else if (event.key === "Escape") {
        this.selectNode(null);
      }
    });
  }

  private selectNode(node: LayoutNode | null): void {
    this.selectedKey = node?.key ?? null;
    this.options.onSelectionChange(node ?? null);
    this.draw();
  }

  private pointerPosition(event: MouseEvent | PointerEvent | WheelEvent): {
    x: number;
    y: number;
  } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  private screenToWorld(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.transform.x) / this.transform.scale,
      y: (y - this.transform.y) / this.transform.scale,
    };
  }

  private hitTest(screenX: number, screenY: number): LayoutNode | null {
    const point = this.screenToWorld(screenX, screenY);
    const visible = this.getVisibleNodes();

    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const node = visible[index];
      const hitRadius = node.radius + 5 / this.transform.scale;
      if (Math.hypot(point.x - node.x, point.y - node.y) <= hitRadius) {
        return node;
      }
    }
    return null;
  }

  private showTooltip(node: LayoutNode, x: number, y: number): void {
    this.tooltip.hidden = false;
    this.tooltip.textContent = [
      escapeTooltipText(node.title),
      node.authors.length > 0
        ? node.authors.slice(0, 3).join(", ")
        : "Unknown author",
      node.year ? String(node.year) : "Year unavailable",
      `${node.citationCount ?? "—"} citations · ${node.referenceCount ?? "—"} references`,
      `${node.incomingLibraryCitations} citations · ${node.outgoingLibraryReferences} references inside this graph`,
      this.collectionLabelByNodeKey.get(node.key) ?? "Unfiled",
    ].join("\n");

    const surface = this.canvas.parentElement;
    const width = surface?.clientWidth ?? this.canvas.clientWidth;
    const height = surface?.clientHeight ?? this.canvas.clientHeight;
    const left = clamp(x + 14, 8, Math.max(8, width - 330));
    const top = clamp(y + 14, 8, Math.max(8, height - 150));
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  private hideTooltip(): void {
    this.tooltip.hidden = true;
  }
}
