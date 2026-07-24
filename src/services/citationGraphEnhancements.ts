import type {
  CitationGraphNode,
  GraphAxisMetric,
  GraphScaleType,
  MetricID,
} from "../domain/graphTypes";
import {
  CitationGraphRenderer,
  type GhostPreview,
} from "./citationGraphRenderer";
import {
  ensureExternalWorkMetrics,
  getExternalWorkMetadata,
  getExternalWorkMetricValue,
  getExternalWorkNodeLabel,
} from "./externalWorkMetricRegistry";
import { metricValue } from "./metricRegistry";

interface Position {
  x: number;
  y: number;
}

interface Rectangle {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface RendererInternals {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  layout: {
    xMetric: GraphAxisMetric;
    xScale: GraphScaleType;
    yMetric: GraphAxisMetric;
    yScale: GraphScaleType;
    nodeSizeMetric: string;
    nodeColorMetric: string;
    nodeLabelMode: "title" | "author-year" | "none";
  };
  positions: Map<string, Position>;
  selectedKey: string | null;
  hoverKey: string | null;
  ghostPreview: GhostPreview | null;
  visibleNodes(): CitationGraphNode[];
  axisScale(
    nodes: CitationGraphNode[],
    axis: "x" | "y",
  ): {
    domain: [number, number];
    ticks: number[];
  } | null;
  nodeRadius(node: CitationGraphNode, domain?: [number, number] | null): number;
  isDarkMode(): boolean;
  draw(): void;
}

const WORLD_WIDTH = 1100;
const WORLD_HEIGHT = 760;
const PLOT_LEFT = 105;
const PLOT_RIGHT = 1030;
const PLOT_TOP = 60;
const PLOT_BOTTOM = 675;
const MISSING_X = PLOT_LEFT - 35;
const MISSING_Y = PLOT_BOTTOM + 35;
const NODE_GAP = 7;
const GRID_CELL_SIZE = 48;

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

function metricNumber(
  node: CitationGraphNode,
  metric: GraphAxisMetric | string,
): number | null {
  if (metric === "free") return null;
  const value = metricValue(node, metric as MetricID);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function ghostMetricNumber(
  preview: GhostPreview,
  metric: GraphAxisMetric,
): number | null {
  if (metric === "free") return null;
  const direct =
    metric === "year"
      ? preview.year
      : metric === "citations"
        ? preview.citationCount
        : metric === "references"
          ? preview.referenceCount
          : getExternalWorkMetricValue(preview.key, metric);
  return typeof direct === "number" && Number.isFinite(direct) ? direct : null;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

const GHOST_GRADIENT_STOPS: Array<[number, RGB]> = [
  [0, { r: 37, g: 99, b: 235 }],
  [0.35, { r: 20, g: 184, b: 211 }],
  [0.68, { r: 250, g: 204, b: 21 }],
  [1, { r: 220, g: 38, b: 38 }],
];

function categoricalColor(value: string | null | undefined): string {
  if (!value) return "rgba(148, 163, 184, .55)";
  return `hsl(${hash(value) % 360} 58% 52%)`;
}

function numericColor(value: number): string {
  const t = clamp(value, 0, 1);
  let left = GHOST_GRADIENT_STOPS[0];
  let right = GHOST_GRADIENT_STOPS.at(-1)!;
  for (let index = 1; index < GHOST_GRADIENT_STOPS.length; index += 1) {
    if (t <= GHOST_GRADIENT_STOPS[index][0]) {
      left = GHOST_GRADIENT_STOPS[index - 1];
      right = GHOST_GRADIENT_STOPS[index];
      break;
    }
  }
  const local = (t - left[0]) / Math.max(1e-9, right[0] - left[0]);
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * local);
  return `rgb(${mix(left[1].r, right[1].r)} ${mix(left[1].g, right[1].g)} ${mix(left[1].b, right[1].b)})`;
}

function metricDomain(
  nodes: CitationGraphNode[],
  metric: string,
): [number, number] | null {
  const values = nodes
    .map((node) => metricNumber(node, metric))
    .filter((value): value is number => value !== null);
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

function ghostRadius(
  renderer: RendererInternals,
  preview: GhostPreview,
  nodes: CitationGraphNode[],
): number {
  const metric = renderer.layout.nodeSizeMetric;
  if (metric === "uniform") return 7;
  const value = getExternalWorkMetricValue(preview.key, metric);
  if (value === null) return 4;
  const domain = metricDomain(nodes, metric);
  if (!domain) return 7;
  if (domain[0] === domain[1]) return 11;
  const normalized = clamp((value - domain[0]) / (domain[1] - domain[0]), 0, 1);
  return Math.sqrt(16 + normalized * (324 - 16));
}

function ghostColor(
  renderer: RendererInternals,
  preview: GhostPreview,
  nodes: CitationGraphNode[],
): string {
  const metric = renderer.layout.nodeColorMetric ?? "collection";
  const work = getExternalWorkMetadata(preview.key);
  if (metric === "collection") return "rgba(148, 163, 184, .55)";
  if (metric === "publication-type") {
    return categoricalColor(work?.publicationType);
  }
  if (metric === "provider") return categoricalColor(work?.provider);
  if (metric === "open-access") {
    return work?.isOpenAccess
      ? categoricalColor(work.openAccessStatus ?? "open")
      : "rgba(148, 163, 184, .55)";
  }
  if (metric === "retraction") {
    return work?.isRetracted ? "rgb(220 38 38)" : "rgba(148, 163, 184, .55)";
  }
  const value = getExternalWorkMetricValue(preview.key, metric);
  const domain = metricDomain(nodes, metric);
  if (value === null || !domain) return "rgba(148, 163, 184, .55)";
  const normalized =
    domain[0] === domain[1]
      ? 0.5
      : clamp((value - domain[0]) / (domain[1] - domain[0]), 0, 1);
  return numericColor(normalized);
}

function maximumDisplacement(metric: GraphAxisMetric): number {
  if (metric === "year") return 36;
  if (metric === "free") return 0;
  return 52;
}

function anchorStrength(metric: GraphAxisMetric): number {
  if (metric === "year") return 0.14;
  return 0.09;
}

function gridCoordinate(value: number): number {
  return Math.floor(value / GRID_CELL_SIZE);
}

function gridKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function clampAroundAnchor(
  position: Position,
  anchor: Position,
  maxX: number,
  maxY: number,
): void {
  position.x = clamp(position.x, anchor.x - maxX, anchor.x + maxX);
  position.y = clamp(position.y, anchor.y - maxY, anchor.y + maxY);
  position.x = clamp(position.x, PLOT_LEFT - 45, PLOT_RIGHT + 45);
  position.y = clamp(position.y, PLOT_TOP - 45, PLOT_BOTTOM + 45);
}

function relaxAnchoredNodes(
  renderer: RendererInternals,
  nodes: CitationGraphNode[],
  anchors: Map<string, Position>,
): void {
  if (nodes.length < 2) return;
  const ordered = [...nodes].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const sizeValues =
    renderer.layout.nodeSizeMetric === "uniform"
      ? []
      : ordered
          .map((node) => metricNumber(node, renderer.layout.nodeSizeMetric))
          .filter((value): value is number => value !== null);
  const sizeDomain: [number, number] | null = sizeValues.length
    ? [Math.min(...sizeValues), Math.max(...sizeValues)]
    : null;
  const radii = new Map(
    ordered.map((node) => [node.key, renderer.nodeRadius(node, sizeDomain)]),
  );
  const maxX = maximumDisplacement(renderer.layout.xMetric);
  const maxY = maximumDisplacement(renderer.layout.yMetric);
  const springX = anchorStrength(renderer.layout.xMetric);
  const springY = anchorStrength(renderer.layout.yMetric);
  const iterations =
    ordered.length <= 500 ? 34 : ordered.length <= 1500 ? 22 : 14;

  for (const node of ordered) {
    const position = renderer.positions.get(node.key);
    const anchor = anchors.get(node.key);
    if (!position || !anchor) continue;
    const seed = hash(node.key);
    const angle = ((seed % 360) * Math.PI) / 180;
    const jitter = 1.5 + ((seed >>> 9) % 35) / 10;
    position.x = anchor.x + Math.cos(angle) * Math.min(jitter, maxX);
    position.y = anchor.y + Math.sin(angle) * Math.min(jitter, maxY);
    clampAroundAnchor(position, anchor, maxX, maxY);
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forces = new Map<string, Position>();
    const grid = new Map<string, number[]>();

    for (const [index, node] of ordered.entries()) {
      const position = renderer.positions.get(node.key);
      const anchor = anchors.get(node.key);
      if (!position || !anchor) continue;
      forces.set(node.key, {
        x: (anchor.x - position.x) * springX,
        y: (anchor.y - position.y) * springY,
      });
      const key = gridKey(
        gridCoordinate(position.x),
        gridCoordinate(position.y),
      );
      const entries = grid.get(key) ?? [];
      entries.push(index);
      grid.set(key, entries);
    }

    for (const [index, node] of ordered.entries()) {
      const position = renderer.positions.get(node.key);
      if (!position) continue;
      const cellX = gridCoordinate(position.x);
      const cellY = gridCoordinate(position.y);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const otherIndex of grid.get(gridKey(cellX + dx, cellY + dy)) ??
            []) {
            if (otherIndex <= index) continue;
            const other = ordered[otherIndex];
            const otherPosition = renderer.positions.get(other.key);
            if (!otherPosition) continue;
            let deltaX = otherPosition.x - position.x;
            let deltaY = otherPosition.y - position.y;
            let distance = Math.hypot(deltaX, deltaY);
            const required =
              (radii.get(node.key) ?? 7) +
              (radii.get(other.key) ?? 7) +
              NODE_GAP;
            if (distance >= required) continue;
            if (distance < 1e-5) {
              const angle =
                ((hash(`${node.key}\u001f${other.key}`) % 360) * Math.PI) / 180;
              deltaX = Math.cos(angle);
              deltaY = Math.sin(angle);
              distance = 1;
            }
            const overlap = required - distance;
            const push = overlap * 0.82;
            const unitX = deltaX / distance;
            const unitY = deltaY / distance;
            const leftForce = forces.get(node.key)!;
            const rightForce = forces.get(other.key)!;
            leftForce.x -= unitX * push;
            leftForce.y -= unitY * push;
            rightForce.x += unitX * push;
            rightForce.y += unitY * push;
          }
        }
      }
    }

    let maximumMovement = 0;
    for (const node of ordered) {
      const position = renderer.positions.get(node.key);
      const anchor = anchors.get(node.key);
      const force = forces.get(node.key);
      if (!position || !anchor || !force) continue;
      const movementX = clamp(force.x * 0.62, -8, 8);
      const movementY = clamp(force.y * 0.62, -8, 8);
      position.x += movementX;
      position.y += movementY;
      clampAroundAnchor(position, anchor, maxX, maxY);
      maximumMovement = Math.max(
        maximumMovement,
        Math.hypot(movementX, movementY),
      );
    }
    if (maximumMovement < 0.08) break;
  }

  // Finish with a collision-only pass. The spring phase keeps every node near
  // its metric anchor; this pass removes the small residual overlaps left at
  // the spring/repulsion equilibrium without changing the anchor limits.
  for (let pass = 0; pass < 10; pass += 1) {
    const grid = new Map<string, number[]>();
    for (const [index, node] of ordered.entries()) {
      const position = renderer.positions.get(node.key);
      if (!position) continue;
      const key = gridKey(
        gridCoordinate(position.x),
        gridCoordinate(position.y),
      );
      const entries = grid.get(key) ?? [];
      entries.push(index);
      grid.set(key, entries);
    }
    let corrected = false;
    for (const [index, node] of ordered.entries()) {
      const position = renderer.positions.get(node.key);
      if (!position) continue;
      const cellX = gridCoordinate(position.x);
      const cellY = gridCoordinate(position.y);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const otherIndex of grid.get(gridKey(cellX + dx, cellY + dy)) ??
            []) {
            if (otherIndex <= index) continue;
            const other = ordered[otherIndex];
            const otherPosition = renderer.positions.get(other.key);
            const anchor = anchors.get(node.key);
            const otherAnchor = anchors.get(other.key);
            if (!otherPosition || !anchor || !otherAnchor) continue;
            let deltaX = otherPosition.x - position.x;
            let deltaY = otherPosition.y - position.y;
            let distance = Math.hypot(deltaX, deltaY);
            const required =
              (radii.get(node.key) ?? 7) +
              (radii.get(other.key) ?? 7) +
              NODE_GAP;
            if (distance >= required - 0.02) continue;
            if (distance < 1e-5) {
              const angle =
                ((hash(`${node.key}\u001f${other.key}`) % 360) * Math.PI) / 180;
              deltaX = Math.cos(angle);
              deltaY = Math.sin(angle);
              distance = 1;
            }
            const correction = (required - distance) / 2 + 0.08;
            const unitX = deltaX / distance;
            const unitY = deltaY / distance;
            position.x -= unitX * correction;
            position.y -= unitY * correction;
            otherPosition.x += unitX * correction;
            otherPosition.y += unitY * correction;
            clampAroundAnchor(position, anchor, maxX, maxY);
            clampAroundAnchor(otherPosition, otherAnchor, maxX, maxY);
            corrected = true;
          }
        }
      }
    }
    if (!corrected) break;
  }
}

function overlapArea(left: Rectangle, right: Rectangle): number {
  const width = Math.max(
    0,
    Math.min(left.right, right.right) - Math.max(left.left, right.left),
  );
  const height = Math.max(
    0,
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
  );
  return width * height;
}

function withinLabelBounds(rectangle: Rectangle): boolean {
  return (
    rectangle.left >= PLOT_LEFT - 45 &&
    rectangle.right <= PLOT_RIGHT + 115 &&
    rectangle.top >= PLOT_TOP - 25 &&
    rectangle.bottom <= PLOT_BOTTOM + 40
  );
}

const prototype = CitationGraphRenderer.prototype as unknown as Record<
  string,
  (...args: any[]) => any
>;

prototype.projectPositionsToLayout = function projectPositionsToLayout(
  preserveFreeX = false,
  preserveFreeY = false,
): void {
  const renderer = this as unknown as RendererInternals;
  const nodes = renderer.visibleNodes();
  const xScale = renderer.axisScale(nodes, "x");
  const yScale = renderer.axisScale(nodes, "y");
  const anchors = new Map<string, Position>();

  for (const [index, node] of nodes.entries()) {
    const position = renderer.positions.get(node.key);
    if (!position) continue;
    let x = position.x;
    let y = position.y;

    if (renderer.layout.xMetric === "free") {
      if (!preserveFreeX) {
        const angle = (index * 2.399963229728653) % (Math.PI * 2);
        x =
          WORLD_WIDTH / 2 + Math.cos(angle) * (60 + Math.sqrt(index + 1) * 18);
      }
    } else if (xScale) {
      const value = metricNumber(node, renderer.layout.xMetric);
      x =
        value === null || (renderer.layout.xScale === "log" && value <= 0)
          ? MISSING_X
          : PLOT_LEFT +
            clamp(
              scaleValue(
                value,
                xScale.domain[0],
                xScale.domain[1],
                renderer.layout.xScale,
              ),
              0,
              1,
            ) *
              (PLOT_RIGHT - PLOT_LEFT);
    }

    if (renderer.layout.yMetric === "free") {
      if (!preserveFreeY) {
        const angle = (index * 2.399963229728653) % (Math.PI * 2);
        y =
          WORLD_HEIGHT / 2 + Math.sin(angle) * (60 + Math.sqrt(index + 1) * 18);
      }
    } else if (yScale) {
      const value = metricNumber(node, renderer.layout.yMetric);
      y =
        value === null || (renderer.layout.yScale === "log" && value <= 0)
          ? MISSING_Y
          : PLOT_BOTTOM -
            clamp(
              scaleValue(
                value,
                yScale.domain[0],
                yScale.domain[1],
                renderer.layout.yScale,
              ),
              0,
              1,
            ) *
              (PLOT_BOTTOM - PLOT_TOP);
    }

    position.x = x;
    position.y = y;
    anchors.set(node.key, { x, y });
  }

  if (
    renderer.layout.xMetric !== "free" &&
    renderer.layout.yMetric !== "free"
  ) {
    relaxAnchoredNodes(renderer, nodes, anchors);
  }
};

prototype.hitTest = function hitTest(
  x: number,
  y: number,
): CitationGraphNode | null {
  const renderer = this as unknown as RendererInternals;
  const nodes = renderer.visibleNodes();
  const sizeValues =
    renderer.layout.nodeSizeMetric === "uniform"
      ? []
      : nodes
          .map((node) => metricNumber(node, renderer.layout.nodeSizeMetric))
          .filter((value): value is number => value !== null);
  const sizeDomain: [number, number] | null = sizeValues.length
    ? [Math.min(...sizeValues), Math.max(...sizeValues)]
    : null;
  let best: CitationGraphNode | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const position = renderer.positions.get(node.key);
    if (!position) continue;
    const radius = renderer.nodeRadius(node, sizeDomain);
    const distance = Math.hypot(position.x - x, position.y - y);
    if (distance > radius + 6) continue;
    const score = distance / Math.max(1, radius);
    const priority =
      node.key === renderer.selectedKey
        ? -0.1
        : node.key === renderer.hoverKey
          ? -0.05
          : 0;
    if (score + priority < bestScore) {
      best = node;
      bestScore = score + priority;
    }
  }
  return best;
};

prototype.drawLabels = function drawLabels(
  nodes: CitationGraphNode[],
  radii: Map<string, number>,
): void {
  const renderer = this as unknown as RendererInternals;
  if (renderer.layout.nodeLabelMode === "none") return;
  const context = renderer.context;
  const limited = nodes.length > 220;
  const ordered = [...nodes]
    .filter(
      (node) =>
        !limited ||
        node.key === renderer.selectedKey ||
        node.key === renderer.hoverKey,
    )
    .sort((left, right) => {
      const priority = (node: CitationGraphNode): number =>
        node.key === renderer.selectedKey
          ? 3
          : node.key === renderer.hoverKey
            ? 2
            : 1;
      return (
        priority(right) - priority(left) ||
        (right.citationCount ?? -1) - (left.citationCount ?? -1) ||
        left.key.localeCompare(right.key)
      );
    });

  context.save();
  context.font = "11px sans-serif";
  context.textBaseline = "middle";
  const nodeRectangles: Rectangle[] = nodes.flatMap((node) => {
    const position = renderer.positions.get(node.key);
    if (!position) return [];
    const radius = (radii.get(node.key) ?? 7) + 3;
    return [
      {
        left: position.x - radius,
        right: position.x + radius,
        top: position.y - radius,
        bottom: position.y + radius,
      },
    ];
  });
  const occupied: Rectangle[] = [];

  for (const node of ordered) {
    const position = renderer.positions.get(node.key);
    if (!position) continue;
    const label =
      renderer.layout.nodeLabelMode === "author-year"
        ? `${node.authors[0]?.split(/\s+/).at(-1) ?? "Unknown"}${node.year ? ` (${node.year})` : ""}`
        : node.title;
    const shortened = label.length > 42 ? `${label.slice(0, 39)}…` : label;
    const width = Math.ceil(context.measureText(shortened).width) + 4;
    const height = 14;
    const radius = radii.get(node.key) ?? 7;
    const gap = radius + 6;
    const candidates = [
      { x: position.x + gap, y: position.y, align: "left" as const },
      { x: position.x - gap, y: position.y, align: "right" as const },
      { x: position.x, y: position.y - gap - 4, align: "center" as const },
      { x: position.x, y: position.y + gap + 4, align: "center" as const },
      { x: position.x + gap, y: position.y - gap, align: "left" as const },
      { x: position.x + gap, y: position.y + gap, align: "left" as const },
      { x: position.x - gap, y: position.y - gap, align: "right" as const },
      { x: position.x - gap, y: position.y + gap, align: "right" as const },
    ];

    const evaluated = candidates.map((candidate) => {
      const left =
        candidate.align === "left"
          ? candidate.x
          : candidate.align === "right"
            ? candidate.x - width
            : candidate.x - width / 2;
      const rectangle: Rectangle = {
        left,
        right: left + width,
        top: candidate.y - height / 2,
        bottom: candidate.y + height / 2,
      };
      const overlap = [...nodeRectangles, ...occupied].reduce(
        (sum, other) => sum + overlapArea(rectangle, other),
        0,
      );
      return {
        ...candidate,
        rectangle,
        overlap: withinLabelBounds(rectangle) ? overlap : overlap + 1_000_000,
      };
    });
    const clearCandidate = evaluated.find(
      (candidate) => candidate.overlap === 0,
    );
    const important =
      node.key === renderer.selectedKey || node.key === renderer.hoverKey;
    const chosen =
      clearCandidate ??
      (important
        ? evaluated.reduce((best, candidate) =>
            candidate.overlap < best.overlap ? candidate : best,
          )
        : null);
    if (!chosen) continue;

    occupied.push(chosen.rectangle);
    const defaultPlacement = chosen === evaluated[0];
    if (!defaultPlacement) {
      const labelEdgeX = clamp(
        position.x,
        chosen.rectangle.left,
        chosen.rectangle.right,
      );
      const labelEdgeY = clamp(
        position.y,
        chosen.rectangle.top,
        chosen.rectangle.bottom,
      );
      context.beginPath();
      context.moveTo(position.x, position.y);
      context.lineTo(labelEdgeX, labelEdgeY);
      context.strokeStyle = renderer.isDarkMode()
        ? "rgba(148, 163, 184, .42)"
        : "rgba(71, 85, 105, .38)";
      context.lineWidth = 0.8;
      context.stroke();
    }

    context.textAlign = chosen.align;
    context.fillStyle = renderer.isDarkMode()
      ? "rgba(248, 250, 252, .94)"
      : "rgba(15, 23, 42, .9)";
    context.fillText(shortened, chosen.x, chosen.y);
  }
  context.restore();
};

prototype.setGhostPreview = function setGhostPreview(
  preview: GhostPreview | null,
): void {
  const renderer = this as unknown as RendererInternals;
  renderer.ghostPreview = preview;
  renderer.draw();
  if (!preview) return;
  void ensureExternalWorkMetrics(preview.key).then(() => {
    if (renderer.ghostPreview?.key === preview.key) renderer.draw();
  });
};

prototype.drawGhost = function drawGhost(): void {
  const renderer = this as unknown as RendererInternals;
  const preview = renderer.ghostPreview;
  if (!preview) return;
  const sources = preview.sourceKeys
    .map((key) => renderer.positions.get(key))
    .filter((position): position is Position => Boolean(position));
  if (!sources.length) return;

  const centroidX =
    sources.reduce((sum, source) => sum + source.x, 0) / sources.length;
  const centroidY =
    sources.reduce((sum, source) => sum + source.y, 0) / sources.length;
  const seed = hash(preview.key);
  const angle = ((seed % 360) * Math.PI) / 180;
  const radius = 70 + (seed % 31);
  let x = clamp(centroidX + Math.cos(angle) * radius, PLOT_LEFT, PLOT_RIGHT);
  let y = clamp(centroidY + Math.sin(angle) * radius, PLOT_TOP, PLOT_BOTTOM);

  const nodes = renderer.visibleNodes();
  const displayedRadius = ghostRadius(renderer, preview, nodes);
  const displayedColor = ghostColor(renderer, preview, nodes);
  const xScale = renderer.axisScale(nodes, "x");
  const yScale = renderer.axisScale(nodes, "y");
  const xValue = ghostMetricNumber(preview, renderer.layout.xMetric);
  const yValue = ghostMetricNumber(preview, renderer.layout.yMetric);
  const missingX =
    renderer.layout.xMetric !== "free" &&
    (xValue === null || (renderer.layout.xScale === "log" && xValue <= 0));
  const missingY =
    renderer.layout.yMetric !== "free" &&
    (yValue === null || (renderer.layout.yScale === "log" && yValue <= 0));

  if (renderer.layout.xMetric !== "free") {
    if (missingX) {
      x = MISSING_X;
    } else if (xScale && xValue !== null) {
      x =
        PLOT_LEFT +
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
  }
  if (renderer.layout.yMetric !== "free") {
    if (missingY) {
      y = MISSING_Y;
    } else if (yScale && yValue !== null) {
      y =
        PLOT_BOTTOM -
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
  }

  const context = renderer.context;
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
  context.arc(x, y, displayedRadius, 0, Math.PI * 2);
  context.fillStyle = displayedColor;
  context.globalAlpha = 0.72;
  context.fill();
  context.globalAlpha = 1;
  context.lineWidth = 1.5;
  context.strokeStyle = "rgba(203, 213, 225, .82)";
  context.stroke();
  context.setLineDash([]);
  if (missingX || missingY) {
    context.fillStyle = renderer.isDarkMode()
      ? "rgba(248,250,252,.94)"
      : "rgba(30,41,59,.9)";
    context.font = "600 11px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("?", x, y + 0.5);
  }
  const label = getExternalWorkNodeLabel(
    preview.key,
    renderer.layout.nodeLabelMode,
    preview.title,
    preview.year,
  );
  if (label) {
    const shortened = label.length > 42 ? `${label.slice(0, 39)}…` : label;
    context.fillStyle = renderer.isDarkMode()
      ? "rgba(248,250,252,.94)"
      : "rgba(30,41,59,.9)";
    context.font = "11px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    context.fillText(shortened, x, y + displayedRadius + 13);
  }
  context.restore();
};

export {};
