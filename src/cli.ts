#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { defaultJourneyConfig, readJourneyConfig } from "./config.ts";
import { extractJourneys } from "./extract-next.ts";
import { renderJourneyHtml } from "./render-html.ts";

function usage(): string {
  return `Sugiyama — deterministic frontend journey maps

Usage: sugiyama [config.json]

With no argument, Sugiyama reads sugiyama.config.json or journeys.config.json when present,
then falls back to src/, tsconfig.json, and artifacts/<project>-user-journeys.html.`;
}

function selectedConfig(argument: string | undefined) {
  if (argument) return readJourneyConfig(argument);
  for (const candidate of ["sugiyama.config.json", "journeys.config.json"]) {
    if (fs.existsSync(candidate)) return readJourneyConfig(candidate);
  }
  return defaultJourneyConfig();
}

function run(): void {
  const argument = process.argv[2];
  if (argument === "--help" || argument === "-h") {
    console.log(usage());
    return;
  }
  const config = selectedConfig(argument);
  const manifest = extractJourneys(config);
  const output = path.resolve(config.output);
  const require = createRequire(import.meta.url);
  const cytoscapeDirectory = path.dirname(require.resolve("cytoscape"));
  const cytoscapeSource = fs.readFileSync(path.join(cytoscapeDirectory, "cytoscape.min.js"), "utf8");
  const elkSource = fs.readFileSync(require.resolve("elkjs/lib/elk.bundled.js"), "utf8");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, renderJourneyHtml(manifest, cytoscapeSource, elkSource));
  fs.writeFileSync(output.replace(/\.html$/i, ".json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    output.replace(/\.html$/i, ".diagnostics.json"),
    `${JSON.stringify(manifest.diagnostics, null, 2)}\n`,
  );
  console.log(`Wrote ${output}`);
  console.log(
    `${manifest.stats.routes} screens, ${manifest.stats.actions} action instances, ${manifest.stats.unresolvedSourceControls} unique unresolved controls (${manifest.stats.unresolvedRouteInstances} route instances)`,
  );
  console.log(
    `${manifest.stats.codeBoundaryInstances} callback boundaries, ${manifest.stats.deadEndInstances} no-handler dead ends, ${manifest.stats.missingLabelSourceControls} source controls without a visible label, ${manifest.stats.dynamicDestinations} runtime destinations`,
  );
  if (manifest.diagnostics.length > 0) {
    for (const diagnostic of manifest.diagnostics.slice(0, 20)) {
      console.error(
        `${diagnostic.evidence.file}:${diagnostic.evidence.line}:${diagnostic.evidence.column} ${diagnostic.message}`,
      );
    }
    if (manifest.diagnostics.length > 20)
      console.error(`...and ${manifest.diagnostics.length - 20} more diagnostics`);
    process.exitCode = 1;
  }
}

try {
  run();
} catch (error) {
  console.error(`Sugiyama failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
