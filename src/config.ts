import fs from "node:fs";
import path from "node:path";

import type { JourneyConfig } from "./types.ts";

function findProjectDirectory(start: string): string {
  let directory = start;
  while (true) {
    if (fs.existsSync(path.join(directory, ".git"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return start;
    directory = parent;
  }
}

export function defaultJourneyConfig(cwd = process.cwd()): JourneyConfig {
  const projectDirectory = findProjectDirectory(cwd);
  const project = path.basename(projectDirectory);
  return {
    output: path.join("artifacts", `${project}-user-journeys.html`),
    project,
    sourceRoot: "src",
    tsConfig: "tsconfig.json",
  };
}

export function readJourneyConfig(configPath: string, cwd = process.cwd()): JourneyConfig {
  const absolutePath = path.resolve(cwd, configPath);
  const value: unknown = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!value || typeof value !== "object") throw new Error("Journey config must be a JSON object");
  const config = value as Partial<JourneyConfig>;
  for (const key of ["output", "sourceRoot", "tsConfig"] as const) {
    if (typeof config[key] !== "string" || !config[key]) throw new Error(`Journey config requires a non-empty ${key}`);
  }
  const projectDirectory = findProjectDirectory(path.dirname(absolutePath));
  return { ...config, project: path.basename(projectDirectory) } as JourneyConfig;
}
