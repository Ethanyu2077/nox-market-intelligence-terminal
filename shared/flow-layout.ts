import type { MosaicNode } from 'react-mosaic-component';
export type FlowPanel = 'price' | 'delta' | 'cvd' | 'oi' | 'tape' | 'liquidations' | 'signals';
export const FLOW_PANELS: FlowPanel[] = ['price', 'delta', 'cvd', 'oi', 'tape', 'liquidations', 'signals'];
export const DEFAULT_FLOW_LAYOUT: MosaicNode<FlowPanel> = { type: 'split', direction: 'row', children: [
  { type: 'split', direction: 'column', children: ['price', 'delta', 'oi', 'cvd'], splitPercentages: [28, 29, 13, 30] },
  { type: 'split', direction: 'column', children: ['tape', 'liquidations', 'signals'], splitPercentages: [45, 25, 30] }
], splitPercentages: [75, 25] };
export function isFlowLayout(value: unknown, seen = new Set<string>(), depth = 0): value is MosaicNode<FlowPanel> {
  if (depth > 10) return false;
  if (typeof value === 'string') { if (!FLOW_PANELS.includes(value as FlowPanel) || seen.has(value)) return false; seen.add(value); return true; }
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  return node.type === 'split' && ['row', 'column'].includes(String(node.direction)) && Array.isArray(node.children) && node.children.length >= 2 && node.children.length <= 7 && (node.splitPercentages === undefined || (Array.isArray(node.splitPercentages) && node.splitPercentages.length === node.children.length && node.splitPercentages.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) && Math.abs(node.splitPercentages.reduce((a: number, n: number) => a + n, 0) - 100) < .1)) && node.children.every(child => isFlowLayout(child, seen, depth + 1));
}
