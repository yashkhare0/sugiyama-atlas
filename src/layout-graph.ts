import type { JourneyManifest } from "./types.ts";

export type GraphPoint = { x: number; y: number };

export type JourneyLayout = {
  bounds: { height: number; width: number };
  positions: Record<string, GraphPoint>;
};

const AREA_GAP = 940;
const ACTION_X = 280;
const TERMINAL_X = 560;
const ROW_HEIGHT = 66;
const ROUTE_GAP = 54;
const ROUTE_MIN_HEIGHT = 142;

export function buildJourneyLayout(manifest: JourneyManifest): JourneyLayout {
  const positions: Record<string, GraphPoint> = {};
  const nodeById = new Map(manifest.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of manifest.edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }

  const areas = [...new Set(manifest.routes.map((route) => route.area))].sort();
  let maxY = 0;
  for (const [areaIndex, area] of areas.entries()) {
    const baseX = areaIndex * AREA_GAP + 120;
    let y = 90;
    const routes = manifest.routes.filter((route) => route.area === area);
    for (const route of routes) {
      const screenId = `screen:${route.path}`;
      const actions = (outgoing.get(screenId) ?? []).map((nodeId) => nodeById.get(nodeId)).filter(Boolean);
      const height = Math.max(ROUTE_MIN_HEIGHT, actions.length * ROW_HEIGHT + 36);
      positions[screenId] = { x: baseX, y: y + height / 2 };
      actions.forEach((action, index) => {
        if (!action) return;
        const actionY = y + 28 + index * ROW_HEIGHT;
        positions[action.id] = { x: baseX + ACTION_X, y: actionY };
        for (const targetId of outgoing.get(action.id) ?? []) {
          const target = nodeById.get(targetId);
          if (target && target.kind !== "screen" && !positions[targetId]) {
            positions[targetId] = { x: baseX + TERMINAL_X, y: actionY };
          }
        }
      });
      y += height + ROUTE_GAP;
    }
    maxY = Math.max(maxY, y);
  }

  let overflowY = 90;
  const overflowX = areas.length * AREA_GAP + 120;
  for (const node of manifest.nodes) {
    if (positions[node.id]) continue;
    positions[node.id] = { x: overflowX, y: overflowY };
    overflowY += ROW_HEIGHT;
  }
  maxY = Math.max(maxY, overflowY);

  return {
    bounds: {
      height: maxY + 90,
      width: overflowX + TERMINAL_X,
    },
    positions,
  };
}

export function zoomToFit(layout: JourneyLayout, viewport: { height: number; width: number }, padding = 72): number {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  return Math.min(availableWidth / layout.bounds.width, availableHeight / layout.bounds.height);
}
