import type { MosaicNode } from 'react-mosaic-component';
export type ResearchPanel = 'chart' | 'research' | 'sources' | 'timeline';
export const RESEARCH_PANELS: ResearchPanel[] = ['chart', 'research', 'sources', 'timeline'];
export const INITIAL_RESEARCH_LAYOUT: MosaicNode<ResearchPanel> = { type: 'split', direction: 'row', children: [{ type: 'split', direction: 'column', children: ['chart', 'timeline'], splitPercentages: [70, 30] }, { type: 'split', direction: 'column', children: ['research', 'sources'], splitPercentages: [65, 35] }], splitPercentages: [65, 35] };
export function validLayout(value: unknown, seen = new Set<string>(), depth = 0): value is MosaicNode<ResearchPanel> {
  if (depth > 7) return false;
  if (typeof value === 'string') { if (!RESEARCH_PANELS.includes(value as ResearchPanel) || seen.has(value)) return false; seen.add(value); return true; }
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  if (node.type === 'split') return (node.direction === 'row' || node.direction === 'column') && Array.isArray(node.children) && node.children.length >= 2 && node.children.length <= 4 && (node.splitPercentages === undefined || (Array.isArray(node.splitPercentages) && node.splitPercentages.length === node.children.length && node.splitPercentages.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0) && Math.abs(node.splitPercentages.reduce((a: number, n: number) => a + n, 0) - 100) < 0.1)) && node.children.every(child => validLayout(child, seen, depth + 1));
  return false;
}
