import { Project, type SourceFile } from "ts-morph";
import type { JourneyConfig } from "./types.ts";
export type Framework = "next" | "vite";
export type RouteSource = {
    area: string;
    file: SourceFile;
    kind: "layout" | "page";
    path: string;
};
export declare function detectFramework(config: JourneyConfig, cwd: string): Framework;
export declare function discoverNextRoutes(project: Project, config: JourneyConfig, cwd: string): RouteSource[];
export declare function discoverViteRoutes(project: Project, config: JourneyConfig, cwd: string): RouteSource[];
//# sourceMappingURL=framework-adapters.d.ts.map