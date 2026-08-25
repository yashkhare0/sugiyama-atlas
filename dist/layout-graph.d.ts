import type { JourneyManifest } from "./types.ts";
export type GraphPoint = {
    x: number;
    y: number;
};
export type JourneyLayout = {
    bounds: {
        height: number;
        width: number;
    };
    positions: Record<string, GraphPoint>;
};
export declare function buildJourneyLayout(manifest: JourneyManifest): JourneyLayout;
export declare function zoomToFit(layout: JourneyLayout, viewport: {
    height: number;
    width: number;
}, padding?: number): number;
//# sourceMappingURL=layout-graph.d.ts.map