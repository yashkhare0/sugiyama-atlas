import { createHash } from "node:crypto";

import type {
  JourneyDiagnostic,
  JourneyEdge,
  JourneyInteraction,
  JourneyManifest,
  JourneyNode,
  JourneyRoute,
} from "./types.ts";

type Extraction = {
  interactions: JourneyInteraction[];
  project: string;
  routes: JourneyRoute[];
  sourceRoot: string;
};

function id(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);
  return `${prefix}:${digest}`;
}

function cleanDestination(value: string): string {
  return (
    value
      .trim()
      .replace(/^['"`]|['"`]$/g, "")
      .split(/[?#]/, 1)[0] || "/"
  );
}

function routeMatches(route: string, destination: string): boolean {
  const routeParts = route.split("/").filter(Boolean);
  const destinationParts = destination.split("/").filter(Boolean);
  if (routeParts.length !== destinationParts.length) return false;
  return routeParts.every((part, index) => {
    if (part.startsWith("[") && part.endsWith("]")) return true;
    return destinationParts[index] === part;
  });
}

function matchRoute(destination: string, routes: JourneyRoute[]): JourneyRoute | undefined {
  const clean = cleanDestination(destination);
  return routes.find((route) => route.path === clean) ?? routes.find((route) => routeMatches(route.path, clean));
}

function isExternalDestination(destination: string): boolean {
  return /^(?:https?:|mailto:)/i.test(cleanDestination(destination));
}

function isRuntimeDestination(destination: string): boolean {
  return !/^(?:\/|https?:|mailto:)/i.test(destination.trim()) || destination.includes("${");
}

function humanize(value: string): string {
  return value
    .replace(/^(?:handle|on|set)(?=[A-Z])/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\bid\b/gi, "ID")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function actionLabel(interaction: JourneyInteraction): string {
  if (!interaction.resolved) return `Control at ${interaction.evidence.file}:${interaction.evidence.line}`;
  const handler = interaction.handler ?? "";
  if (/\bopenDialog\b/.test(handler)) return "Open dialog";
  if (/\bonOpenChange\b|\bsetIsOpen\b/.test(handler)) return "Expand or collapse section";
  if (/\bonSelect\s*\(\s*version\s*\)/.test(handler)) return "Select version";
  let label = interaction.label
    .replace(/`/g, "")
    .replace(/\$\{([A-Za-z_$][\w$]*)\.(?:label|name|text|title)[^}]*\}/g, "$1")
    .replace(/\$\{[^}]+\}/g, "")
    .replace(/^Label\s+(?=Accept|Reject|Pending)/i, "")
    .replace(/[←→]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const subject = subjectFromEvidence(interaction);
  if (/^href$/i.test(label)) label = `Open ${subject}`;
  else if (/^open$/i.test(label)) label = `Open ${subject}`;
  else if (/^label$/i.test(label)) label = `Open ${subject} details`;
  else if (/^value$/i.test(label)) label = `Select ${subject}`;
  else if (/^title$/i.test(label)) label = `Open ${subject}`;
  else if (/^name$/i.test(label)) label = `${subject} name`;
  else if (/^[A-Z][A-Z0-9_]+$/.test(label)) label = humanize(label);
  return label.startsWith("[") ? "Unlabelled control" : label;
}

function subjectFromEvidence(interaction: JourneyInteraction): string {
  const file =
    interaction.evidence.file
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/, "") ?? "Item";
  const parts = file.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/);
  const entity = parts.find((part) => /^(?:candidate|job|persona|user|playlist|profile|application)$/i.test(part));
  if (entity) return entity;
  return (
    parts.find((part) => !/(?:button|dialog|section|page|panel|detail|action|review|table|row)/i.test(part)) ?? "Item"
  );
}

function externalLabel(interaction: JourneyInteraction): string {
  const destination = interaction.destination ?? "";
  if (/linkedin/i.test(destination) || /linkedin/i.test(interaction.label)) return "LinkedIn profile of {person}";
  if (/github/i.test(destination) || /github/i.test(interaction.label)) return "GitHub profile or repository";
  if (/ashby/i.test(destination) || /ashby/i.test(interaction.label)) return "Ashby record";
  if (/mailto:/i.test(destination)) return "Email application";
  return `External: ${actionLabel(interaction)}`;
}

function localOutcome(
  interaction: JourneyInteraction,
): { kind: "code-boundary" | "completed-outcome" | "dead-end" | "view-state"; label: string; proof: "inferred" | "source" } | undefined {
  if (interaction.staticOutcome) return { kind: "view-state", label: interaction.staticOutcome, proof: "source" };
  if (interaction.kind === "input") return { kind: "view-state", label: "Field value changes", proof: "source" };
  if (interaction.kind === "selection") return { kind: "view-state", label: "Selection changes", proof: "source" };
  const handler = interaction.handler ?? "";
  const successMessage = handler.match(/toast\.success\(\s*["']([^"']+)["']/)?.[1];
  if (successMessage) return { kind: "completed-outcome", label: successMessage, proof: "source" };
  if (/clipboard\.writeText\s*\(/.test(handler)) {
    return { kind: "completed-outcome", label: "Copied to clipboard", proof: "source" };
  }
  if (/(?:createObjectURL|\.download\s*=)/.test(handler)) {
    return { kind: "completed-outcome", label: "File download starts", proof: "source" };
  }
  const stateSetter = handler.match(/\bset([A-Z][A-Za-z0-9_$]*)\s*(?:\(|$)/)?.[1];
  if (stateSetter) {
    return { kind: "view-state", label: `${humanize(stateSetter)} changes`, proof: "source" };
  }
  if (!handler) {
    return { kind: "dead-end", label: "No application handler is wired", proof: "source" };
  }
  const explicitStatus = handler.match(/(?:onLabel(?:Change)?|setStatus|setState)\(\s*["']([^"']+)["']/i)?.[1];
  if (explicitStatus) {
    return { kind: "view-state", label: `Status is set to ${humanize(explicitStatus)}`, proof: "source" };
  }
  if (/set(?:Is)?Open\s*\(/.test(handler)) {
    return { kind: "view-state", label: "Inferred: open state changes", proof: "inferred" };
  }
  const calls = [...handler.matchAll(/(?:await\s+|void\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)].map(
    (match) => match[1],
  );
  const call = calls.find((candidate) => !/(?:preventDefault|stopPropagation)$/.test(candidate));
  const bare = handler.match(/^([A-Za-z_$][\w$]*)/)?.[1];
  const operation = (call?.split(".").at(-1) ?? bare) || "";
  if (!operation) return undefined;
  if (/^(?:preventDefault|stopPropagation)$/i.test(operation)) return undefined;
  if (/refetch/i.test(operation)) return { kind: "view-state", label: "Data reload requested", proof: "source" };
  const mutation = handler.match(/\b([A-Za-z_$][\w$]*)\.(?:mutate|mutateAsync)\s*\(/)?.[1];
  if (mutation) {
    return { kind: "view-state", label: `${humanize(mutation)} request starts`, proof: "source" };
  }
  if (/^set[A-Z]/.test(operation)) {
    return { kind: "view-state", label: `${humanize(operation)} changes`, proof: "source" };
  }
  if (/submit/i.test(operation)) return { kind: "code-boundary", label: "Runs form submission handler", proof: "source" };
  if (/\bwindow\.open\s*\(/.test(handler)) {
    return { kind: "view-state", label: "A new browser tab opens", proof: "source" };
  }
  if (/\.current\?*\.click\s*\(/.test(handler)) {
    return { kind: "view-state", label: "The linked browser control opens", proof: "source" };
  }
  if (operation) {
    return { kind: "code-boundary", label: `Runs ${operation}()`, proof: "source" };
  }
  return { kind: "code-boundary", label: `Runs ${handler.slice(0, 80)}`, proof: "source" };
}

function addNode(nodes: Map<string, JourneyNode>, node: JourneyNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

export function buildJourneyGraph(extraction: Extraction): JourneyManifest {
  const nodes = new Map<string, JourneyNode>();
  const edges = new Map<string, JourneyEdge>();
  const diagnostics: JourneyDiagnostic[] = [];
  const routeNodeIds = new Map<string, string>();

  for (const route of extraction.routes) {
    const nodeId = `screen:${route.path}`;
    routeNodeIds.set(route.path, nodeId);
    addNode(nodes, {
      area: route.area,
      evidence: { column: 1, file: route.file, line: 1 },
      id: nodeId,
      kind: "screen",
      label: route.path === "Global shell" ? "Global navigation" : route.path,
      route: route.path,
    });
  }

  for (const route of extraction.routes) {
    const source = routeNodeIds.get(route.path)!;
    for (const destination of route.redirects) {
      const destinationRoute = matchRoute(destination, extraction.routes);
      if (!destinationRoute) continue;
      const target = routeNodeIds.get(destinationRoute.path)!;
      const redirectId = id("edge", source, target, "redirects");
      edges.set(redirectId, { id: redirectId, kind: "redirects", proof: "source", source, target });
    }
  }

  const interactionById = new Map(extraction.interactions.map((interaction) => [interaction.id, interaction]));
  for (const route of extraction.routes) {
    for (const transition of route.unresolvedRedirects ?? []) {
      diagnostics.push({
        candidates: [],
        evidence: transition.evidence,
        interactionId: id("system-transition", route.path, transition.expression),
        message: `Redirect destination could not be resolved statically: ${transition.expression}`,
        route: route.path,
        severity: "error",
        trace: [transition.expression],
      });
    }
    const source = routeNodeIds.get(route.path)!;
    for (const interactionId of route.interactions) {
      const interaction = interactionById.get(interactionId);
      if (!interaction) continue;
      const actionId = id("action", route.path, interaction.id);
      addNode(nodes, {
        area: route.area,
        conditions: interaction.conditions,
        evidence: interaction.evidence,
        id: actionId,
        kind: "action",
        label: actionLabel(interaction),
        labelProof: interaction.labelProof,
        proof: interaction.resolved ? "source" : "inferred",
        route: route.path,
        sourceExpression: interaction.sourceExpression,
      });
      const actsId = id("edge", source, actionId, "acts");
      edges.set(actsId, { id: actsId, kind: "acts", proof: "source", source, target: actionId });

      if (!interaction.resolved) {
        diagnostics.push({
          candidates: [],
          evidence: interaction.evidence,
          interactionId: interaction.id,
          message: "Visible control label could not be resolved statically",
          route: route.path,
          severity: "error",
          trace: [interaction.sourceExpression ?? interaction.handler ?? "No static label"],
        });
      }

      const resolvedTargets: Array<{ edgeKind: JourneyEdge["kind"]; target: JourneyNode }> = [];
      if (interaction.destination) {
        const candidates = [interaction.destination, ...(interaction.destinationCandidates ?? [])];
        const hasConcreteCandidate = candidates.some(
          (candidate) => Boolean(matchRoute(candidate, extraction.routes)) || isExternalDestination(candidate),
        );
        for (const destination of candidates) {
          const destinationRoute = matchRoute(destination, extraction.routes);
          if (destinationRoute) {
            const screen = nodes.get(routeNodeIds.get(destinationRoute.path)!);
            if (screen && !resolvedTargets.some(({ target }) => target.id === screen.id)) {
              resolvedTargets.push({ edgeKind: "opens", target: screen });
            }
          } else if (isExternalDestination(destination) || interaction.kind === "external-link") {
            const label = externalLabel(interaction);
            const external = { id: id("external", label), kind: "external-exit" as const, label };
            if (!resolvedTargets.some(({ target }) => target.id === external.id)) {
              resolvedTargets.push({ edgeKind: "exits", target: external });
            }
          } else if (!hasConcreteCandidate && isRuntimeDestination(destination)) {
            const dynamic = {
              id: id("dynamic-destination", destination),
              kind: "dynamic-destination" as const,
              label: `Runtime destination: ${destination}`,
              proof: "source" as const,
            };
            if (!resolvedTargets.some(({ target }) => target.id === dynamic.id)) {
              resolvedTargets.push({ edgeKind: "opens", target: dynamic });
            }
          }
        }
      } else {
        const outcome = resolvedTargets.length ? undefined : localOutcome(interaction);
        if (outcome) {
          resolvedTargets.push({
            edgeKind:
              outcome.kind === "view-state"
                ? "updates"
                : outcome.kind === "code-boundary"
                  ? "invokes"
                  : outcome.kind === "dead-end"
                    ? "stops"
                    : "completes",
            target: {
              id: id("outcome", route.path, interaction.id, outcome.label),
              kind: outcome.kind,
              label: outcome.label,
              proof: outcome.proof,
            },
          });
          if (outcome.proof === "inferred") {
            diagnostics.push({
              candidates: [],
              evidence: interaction.evidence,
              interactionId: interaction.id,
              message: `User-visible outcome is inferred rather than proven: ${outcome.label.replace(/^Inferred:\s*/i, "")}`,
              route: route.path,
              severity: "error",
              trace: [interaction.sourceExpression ?? interaction.handler ?? "No handler expression"],
            });
          }
        }
      }

      if (!resolvedTargets.length) {
        const unresolvedId = id("unresolved", route.path, interaction.id);
        resolvedTargets.push({
          edgeKind: "unresolved",
          target: { id: unresolvedId, kind: "unresolved-path", label: "Outcome unresolved" },
        });
        diagnostics.push({
          candidates: interaction.destination
            ? extraction.routes
                .map((candidate) => candidate.path)
                .filter((path) => path.includes(cleanDestination(interaction.destination!)))
            : [],
          evidence: interaction.evidence,
          interactionId: interaction.id,
          message: interaction.destination
            ? `No canonical screen matches ${interaction.destination}`
            : `No user-visible outcome could be inferred for ${actionLabel(interaction)}`,
          route: route.path,
          severity: "error",
          trace: [
            `${interaction.kind}: ${actionLabel(interaction)}`,
            interaction.sourceExpression ?? interaction.handler ?? "No handler expression",
          ],
        });
      }
      for (const { edgeKind, target } of resolvedTargets) {
        addNode(nodes, target);
        const resultId = id("edge", actionId, target.id, edgeKind);
        edges.set(resultId, {
          id: resultId,
          kind: edgeKind,
          proof:
            target.kind === "view-state" ||
            target.kind === "completed-outcome" ||
            target.kind === "code-boundary" ||
            target.kind === "dead-end"
              ? target.proof
              : "source",
          source: actionId,
          target: target.id,
        });
      }
    }
  }

  const sortedNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const sortedEdges = [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
  diagnostics.sort(
    (left, right) => left.evidence.file.localeCompare(right.evidence.file) || left.evidence.line - right.evidence.line,
  );
  const unresolvedRouteInstances = new Set(
    diagnostics
      .filter((diagnostic) => !diagnostic.interactionId.startsWith("system-transition:"))
      .map((diagnostic) => `${diagnostic.route}\u0000${diagnostic.interactionId}`),
  ).size;
  const unresolvedSystemTransitions = new Set(
    diagnostics
      .filter((diagnostic) => diagnostic.interactionId.startsWith("system-transition:"))
      .map((diagnostic) => diagnostic.interactionId),
  ).size;
  const unresolvedControlIds = new Set(
    diagnostics
      .filter((diagnostic) => !diagnostic.interactionId.startsWith("system-transition:"))
      .map((diagnostic) => diagnostic.interactionId),
  );
  return {
    diagnostics,
    edges: sortedEdges,
    interactions: extraction.interactions,
    nodes: sortedNodes,
    project: extraction.project,
    routes: extraction.routes,
    schemaVersion: 2,
    sourceRoot: extraction.sourceRoot,
    stats: {
      actions: sortedNodes.filter((node) => node.kind === "action").length,
      codeBoundaryInstances: sortedNodes.filter((node) => node.kind === "code-boundary").length,
      deadEndInstances: sortedNodes.filter((node) => node.kind === "dead-end").length,
      dynamicDestinations: sortedNodes.filter((node) => node.kind === "dynamic-destination").length,
      edges: sortedEdges.length,
      externalExits: sortedNodes.filter((node) => node.kind === "external-exit").length,
      nodes: sortedNodes.length,
      routes: extraction.routes.length,
      missingLabelSourceControls: extraction.interactions.filter((interaction) => interaction.labelProof === "missing").length,
      unresolvedActions: unresolvedControlIds.size,
      unresolvedRouteInstances,
      unresolvedSourceControls: unresolvedControlIds.size,
      unresolvedSystemTransitions,
    },
  };
}
