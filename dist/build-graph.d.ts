import type { JourneyInteraction, JourneyManifest, JourneyRoute } from "./types.ts";
type Extraction = {
    interactions: JourneyInteraction[];
    project: string;
    routes: JourneyRoute[];
    sourceRoot: string;
};
export declare function buildJourneyGraph(extraction: Extraction): JourneyManifest;
export {};
//# sourceMappingURL=build-graph.d.ts.map