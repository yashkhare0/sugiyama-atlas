export type InteractionKind = "button" | "external-link" | "form" | "input" | "link" | "selection" | "trigger";
export type Evidence = {
    column: number;
    file: string;
    line: number;
};
export type JourneyInteraction = {
    conditions: string[];
    destination?: string;
    destinationCandidates?: string[];
    evidence: Evidence;
    handler?: string;
    id: string;
    kind: InteractionKind;
    label: string;
    labelProof?: "missing" | "semantic" | "visible";
    resolved: boolean;
    routes: string[];
    sourceExpression?: string;
    staticOutcome?: string;
};
export type JourneyRoute = {
    area: string;
    file: string;
    interactions: string[];
    kind: "layout" | "page";
    path: string;
    redirects: string[];
    unresolvedRedirects?: Array<{
        evidence: Evidence;
        expression: string;
    }>;
};
export type JourneyNodeKind = "action" | "code-boundary" | "completed-outcome" | "dead-end" | "dynamic-destination" | "external-exit" | "screen" | "unresolved-path" | "view-state";
export type JourneyNode = {
    area?: string;
    conditions?: string[];
    evidence?: Evidence;
    id: string;
    kind: JourneyNodeKind;
    label: string;
    labelProof?: "missing" | "semantic" | "visible";
    proof?: "inferred" | "source";
    route?: string;
    sourceExpression?: string;
};
export type JourneyEdgeKind = "acts" | "completes" | "exits" | "invokes" | "opens" | "redirects" | "stops" | "unresolved" | "updates";
export type JourneyEdge = {
    id: string;
    kind: JourneyEdgeKind;
    proof?: "inferred" | "source";
    source: string;
    target: string;
};
export type JourneyDiagnostic = {
    candidates: string[];
    evidence: Evidence;
    interactionId: string;
    message: string;
    route: string;
    severity: "error";
    trace: string[];
};
export type JourneyManifest = {
    diagnostics: JourneyDiagnostic[];
    edges: JourneyEdge[];
    interactions: JourneyInteraction[];
    nodes: JourneyNode[];
    project: string;
    routes: JourneyRoute[];
    schemaVersion: 2;
    sourceRoot: string;
    stats: {
        actions: number;
        codeBoundaryInstances: number;
        deadEndInstances: number;
        dynamicDestinations: number;
        edges: number;
        externalExits: number;
        nodes: number;
        routes: number;
        missingLabelSourceControls: number;
        unresolvedRouteInstances: number;
        unresolvedSourceControls: number;
        unresolvedSystemTransitions: number;
        /** @deprecated Use unresolvedSourceControls. */
        unresolvedActions: number;
    };
};
export type JourneyConfig = {
    appDirectory?: string;
    areaLabels?: Record<string, string>;
    framework?: "next" | "vite";
    output: string;
    project: string;
    sourceRoot: string;
    tsConfig: string;
};
//# sourceMappingURL=types.d.ts.map