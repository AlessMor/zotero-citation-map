import type {
  CitationGraphNode,
  GraphAxisMetric,
  GraphScaleType,
  MetricID,
} from "../domain/graphTypes";
import { getMetricDefinition, metricValue } from "./metricRegistry";

export interface AxisScale {
  domain: [number, number];
  ticks: number[];
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

export const GRAPH_COLOR_GRADIENT_STOPS: ReadonlyArray<readonly [number, RGB]> =
  [
    [0, { r: 37, g: 99, b: 235 }],
    [0.35, { r: 20, g: 184, b: 211 }],
    [0.68, { r: 250, g: 204, b: 21 }],
    [1, { r: 220, g: 38, b: 38 }],
  ];

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function hashString(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function categoricalColor(
  value: string | null | undefined,
  missingColor = "hsl(220 7% 58%)",
): string {
  if (!value) return missingColor;
  return `hsl(${hashString(value) % 360} 58% 52%)`;
}

export function numericColor(value: number): string {
  const t = clamp(value, 0, 1);
  let left = GRAPH_COLOR_GRADIENT_STOPS[0];
  let right = GRAPH_COLOR_GRADIENT_STOPS.at(-1)!;
  for (let index = 1; index < GRAPH_COLOR_GRADIENT_STOPS.length; index += 1) {
    if (t <= GRAPH_COLOR_GRADIENT_STOPS[index][0]) {
      left = GRAPH_COLOR_GRADIENT_STOPS[index - 1];
      right = GRAPH_COLOR_GRADIENT_STOPS[index];
      break;
    }
  }
  const local = (t - left[0]) / Math.max(1e-9, right[0] - left[0]);
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * local);
  return `rgb(${mix(left[1].r, right[1].r)} ${mix(left[1].g, right[1].g)} ${mix(left[1].b, right[1].b)})`;
}

export function scaleValue(
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

export function inverseScaleValue(
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

export function metricNumber(
  node: CitationGraphNode,
  metric: GraphAxisMetric | MetricID | string,
): number | null {
  if (metric === "free") return null;
  const value = metricValue(node, metric as MetricID);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function metricExtent(
  nodes: CitationGraphNode[],
  metric: GraphAxisMetric | MetricID | string,
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

export function niceStep(
  span: number,
  target: number,
  integer: boolean,
): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const multiplier =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = multiplier * magnitude;
  return integer ? Math.max(1, Math.ceil(step)) : step;
}

function linearAxisScale(
  values: number[],
  metric: GraphAxisMetric,
  target: number,
): AxisScale | null {
  if (!values.length || metric === "free") return null;
  let minimum = Math.min(...values);
  let maximum = Math.max(...values);
  const integer = getMetricDefinition(metric).valueType === "integer";

  if (minimum === maximum) {
    const padding = integer
      ? Math.max(1, Math.ceil(Math.abs(minimum) * 0.05))
      : Math.max(0.5, Math.abs(minimum) * 0.05);
    minimum -= padding;
    maximum += padding;
  }

  const step = niceStep(maximum - minimum, target, integer);
  let domainMinimum = Math.floor(minimum / step) * step;
  let domainMaximum = Math.ceil(maximum / step) * step;

  if (minimum >= 0 && domainMinimum < 0) domainMinimum = 0;
  if (domainMaximum < maximum) domainMaximum += step;
  if (domainMinimum > minimum) domainMinimum -= step;
  if (domainMinimum === domainMaximum) domainMaximum += step;

  const ticks: number[] = [];
  for (
    let value = domainMinimum;
    value <= domainMaximum + step * 1e-8;
    value += step
  ) {
    ticks.push(Number(value.toPrecision(12)));
    if (ticks.length > 30) break;
  }

  return { domain: [domainMinimum, domainMaximum], ticks };
}

function logAxisScale(values: number[], target: number): AxisScale | null {
  const positive = values.filter((value) => value > 0);
  if (!positive.length) return null;
  const minimum = Math.min(...positive);
  const maximum = Math.max(...positive);
  let firstExponent = Math.floor(Math.log10(minimum));
  let lastExponent = Math.ceil(Math.log10(maximum));
  if (firstExponent === lastExponent) {
    firstExponent -= 1;
    lastExponent += 1;
  }
  const domain: [number, number] = [10 ** firstExponent, 10 ** lastExponent];
  const candidates: number[] = [];
  for (let exponent = firstExponent; exponent <= lastExponent; exponent += 1) {
    const power = 10 ** exponent;
    for (const multiplier of [1, 2, 5]) {
      const value = multiplier * power;
      if (value >= domain[0] && value <= domain[1]) candidates.push(value);
    }
  }
  if (candidates.length <= target + 2) return { domain, ticks: candidates };
  const stride = Math.max(
    1,
    Math.ceil(candidates.length / Math.max(2, target)),
  );
  const ticks = candidates.filter((_value, index) => index % stride === 0);
  if (ticks.at(-1) !== domain[1]) ticks.push(domain[1]);
  return { domain, ticks };
}

export function axisScaleForNodes(
  nodes: CitationGraphNode[],
  metric: GraphAxisMetric,
  scale: GraphScaleType,
  target: number,
): AxisScale | null {
  if (metric === "free") return null;
  const values = nodes
    .map((node) => metricNumber(node, metric))
    .filter(
      (value): value is number =>
        value !== null && (scale !== "log" || value > 0),
    );
  return scale === "log"
    ? logAxisScale(values, target)
    : linearAxisScale(values, metric, target);
}
