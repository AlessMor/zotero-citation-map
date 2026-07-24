import type { GraphAxisMetric, GraphScaleType } from "../domain/graphTypes";
import { getMetricDefinition } from "./metricRegistry";

export interface GraphAxisViewport {
  canvasWidth: number;
  canvasHeight: number;
  canvasCssWidth: number;
  transform: { x: number; y: number; scale: number };
}

const WORLD_PLOT = {
  left: 105,
  right: 1030,
  top: 60,
  bottom: 675,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function inverseScaleValue(
  normalized: number,
  domain: [number, number],
  scale: GraphScaleType,
): number {
  const t = clamp(normalized, 0, 1);
  if (scale === "log") {
    if (domain[0] <= 0 || domain[1] <= 0) return domain[0];
    return Math.exp(
      Math.log(domain[0]) + t * (Math.log(domain[1]) - Math.log(domain[0])),
    );
  }
  return domain[0] + t * (domain[1] - domain[0]);
}

export function visibleMetricDomain(
  viewport: GraphAxisViewport,
  axis: "x" | "y",
  fullDomain: [number, number],
  scale: GraphScaleType,
): [number, number] {
  const ratio = viewport.canvasWidth / Math.max(1, viewport.canvasCssWidth);
  const screenMinimum = axis === "x" ? 58 * ratio : 14 * ratio;
  const screenMaximum =
    axis === "x"
      ? viewport.canvasWidth - 14 * ratio
      : viewport.canvasHeight - 42 * ratio;
  const transformOffset =
    axis === "x" ? viewport.transform.x : viewport.transform.y;
  const worldMinimum =
    (screenMinimum - transformOffset) / viewport.transform.scale;
  const worldMaximum =
    (screenMaximum - transformOffset) / viewport.transform.scale;

  let firstNormalized: number;
  let secondNormalized: number;
  if (axis === "x") {
    const left = clamp(worldMinimum, WORLD_PLOT.left, WORLD_PLOT.right);
    const right = clamp(worldMaximum, WORLD_PLOT.left, WORLD_PLOT.right);
    if (right <= left) return fullDomain;
    firstNormalized =
      (left - WORLD_PLOT.left) / (WORLD_PLOT.right - WORLD_PLOT.left);
    secondNormalized =
      (right - WORLD_PLOT.left) / (WORLD_PLOT.right - WORLD_PLOT.left);
  } else {
    const top = clamp(worldMinimum, WORLD_PLOT.top, WORLD_PLOT.bottom);
    const bottom = clamp(worldMaximum, WORLD_PLOT.top, WORLD_PLOT.bottom);
    if (bottom <= top) return fullDomain;
    firstNormalized =
      (WORLD_PLOT.bottom - bottom) / (WORLD_PLOT.bottom - WORLD_PLOT.top);
    secondNormalized =
      (WORLD_PLOT.bottom - top) / (WORLD_PLOT.bottom - WORLD_PLOT.top);
  }

  const first = inverseScaleValue(firstNormalized, fullDomain, scale);
  const second = inverseScaleValue(secondNormalized, fullDomain, scale);
  return first <= second ? [first, second] : [second, first];
}

function niceStep(span: number, target: number, integer: boolean): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const multiplier =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = multiplier * magnitude;
  return integer ? Math.max(1, Math.ceil(step)) : step;
}

function linearTicks(
  domain: [number, number],
  metric: Exclude<GraphAxisMetric, "free">,
  target: number,
): number[] {
  const integer = getMetricDefinition(metric).valueType === "integer";
  const step = niceStep(domain[1] - domain[0], target, integer);
  const ticks: number[] = [];
  const epsilon = step * 1e-8;
  for (
    let value = Math.ceil((domain[0] - epsilon) / step) * step;
    value <= domain[1] + epsilon;
    value += step
  ) {
    const tick = integer ? Math.round(value) : Number(value.toPrecision(12));
    if (!ticks.length || tick !== ticks.at(-1)) ticks.push(tick);
    if (ticks.length > 80) break;
  }
  if (!ticks.length) {
    const middle = (domain[0] + domain[1]) / 2;
    const fallback = integer ? Math.round(middle) : middle;
    if (fallback >= domain[0] && fallback <= domain[1]) ticks.push(fallback);
  }
  return ticks;
}

function logTicks(domain: [number, number], target: number): number[] {
  if (domain[0] <= 0 || domain[1] <= 0) return [];
  const candidates: number[] = [];
  const firstExponent = Math.floor(Math.log10(domain[0]));
  const lastExponent = Math.ceil(Math.log10(domain[1]));
  for (let exponent = firstExponent; exponent <= lastExponent; exponent += 1) {
    const power = 10 ** exponent;
    for (const multiplier of [1, 2, 5]) {
      const value = multiplier * power;
      if (value >= domain[0] && value <= domain[1]) candidates.push(value);
    }
  }
  if (candidates.length <= target + 2) return candidates;
  const stride = Math.max(
    1,
    Math.ceil(candidates.length / Math.max(2, target)),
  );
  return candidates.filter((_value, index) => index % stride === 0);
}

export function axisTicksForVisibleDomain(
  domain: [number, number],
  metric: Exclude<GraphAxisMetric, "free">,
  scale: GraphScaleType,
  target: number,
): number[] {
  return scale === "log"
    ? logTicks(domain, target)
    : linearTicks(domain, metric, target);
}
