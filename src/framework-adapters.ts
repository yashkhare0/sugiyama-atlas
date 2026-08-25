import fs from "node:fs";
import path from "node:path";

import { Node, Project, type SourceFile } from "ts-morph";

import type { JourneyConfig } from "./types.ts";

export type Framework = "next" | "vite";

export type RouteSource = {
  area: string;
  file: SourceFile;
  kind: "layout" | "page";
  path: string;
};

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function areaForRoute(route: string, labels: Record<string, string>): string {
  const segment = route.split("/").filter(Boolean)[0] ?? "home";
  return labels[segment] ?? segment.replaceAll("-", " ").replace(/^./, (value) => value.toUpperCase());
}

function normalizeRoute(value: string): string {
  const clean = value.trim().replace(/^#/, "").replace(/\*$/, "").replace(/\/+/g, "/");
  const absolute = clean.startsWith("/") ? clean : `/${clean}`;
  const normalized = absolute.replace(/:([A-Za-z_$][\w$]*)/g, "[$1]").replace(/\/$/, "");
  return normalized || "/";
}

function joinRouteParts(parts: string[]): string {
  let route = "";
  for (const part of parts) {
    if (part.startsWith("/")) route = part;
    else route = `${route.replace(/\/$/, "")}/${part}`;
  }
  return normalizeRoute(route || "/");
}

function nextRoute(appDirectory: string, filePath: string): string {
  const relative = toPosix(path.relative(appDirectory, path.dirname(filePath)));
  if (!relative || relative === ".") return "/";
  return `/${relative
    .split("/")
    .filter((part) => !part.startsWith("(") && !part.startsWith("@"))
    .join("/")}`;
}

function staticJsxAttribute(node: Node, name: string): string | undefined {
  if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) return undefined;
  const attribute = node.getAttribute(name);
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  if (!initializer) return undefined;
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralValue();
  if (!Node.isJsxExpression(initializer)) return undefined;
  const expression = initializer.getExpression();
  if (expression && (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression))) {
    return expression.getLiteralValue();
  }
  return undefined;
}

function componentSource(node: Node): SourceFile | undefined {
  const element = Node.isJsxExpression(node) ? node.getExpression() : node;
  if (!element) return undefined;
  let tag: Node | undefined;
  if (Node.isJsxSelfClosingElement(element)) tag = element.getTagNameNode();
  else if (Node.isJsxElement(element)) tag = element.getOpeningElement().getTagNameNode();
  else if (Node.isIdentifier(element)) tag = element;
  if (!tag) return undefined;
  const symbol = tag.getSymbol();
  const declarations = [...(symbol?.getDeclarations() ?? []), ...(symbol?.getAliasedSymbol()?.getDeclarations() ?? [])];
  const sources = declarations.map((declaration) => declaration.getSourceFile()).filter((source) => !source.isDeclarationFile());
  return sources.find((source) => source !== node.getSourceFile()) ?? sources[0];
}

function routeElementSource(node: Node): SourceFile | undefined {
  if (Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)) {
    const attribute = node.getAttribute("element");
    if (attribute && Node.isJsxAttribute(attribute)) return componentSource(attribute.getInitializer() ?? attribute);
  }
  if (Node.isObjectLiteralExpression(node)) {
    const property = node.getProperty("element") ?? node.getProperty("Component");
    if (property && Node.isPropertyAssignment(property)) return componentSource(property.getInitializer() ?? property);
  }
  return undefined;
}

function objectPath(node: Node): string | undefined {
  if (!Node.isObjectLiteralExpression(node)) return undefined;
  const property = node.getProperty("path");
  if (!property || !Node.isPropertyAssignment(property)) return undefined;
  const initializer = property.getInitializer();
  return initializer && (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer))
    ? initializer.getLiteralValue()
    : undefined;
}

function jsxRoutePath(node: Node): string | undefined {
  if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) return undefined;
  const ownPath = staticJsxAttribute(node, "path");
  const isIndex = Boolean(node.getAttribute("index"));
  if (!ownPath && !isIndex) return undefined;
  const ancestors = node
    .getAncestors()
    .filter(Node.isJsxElement)
    .filter((ancestor) => ancestor.getOpeningElement().getTagNameNode().getText().split(".").at(-1) === "Route")
    .map((ancestor) => staticJsxAttribute(ancestor.getOpeningElement(), "path"))
    .filter((value): value is string => Boolean(value))
    .reverse();
  return joinRouteParts([...ancestors, ...(ownPath ? [ownPath] : [])]);
}

function objectRoutePath(node: Node): string | undefined {
  if (!Node.isObjectLiteralExpression(node)) return undefined;
  const ownPath = objectPath(node);
  const indexProperty = node.getProperty("index");
  const isIndex =
    indexProperty &&
    Node.isPropertyAssignment(indexProperty) &&
    indexProperty.getInitializer()?.getText() === "true";
  if (!ownPath && !isIndex) return undefined;
  const ancestors = node
    .getAncestors()
    .filter(Node.isObjectLiteralExpression)
    .map(objectPath)
    .filter((value): value is string => Boolean(value))
    .reverse();
  return joinRouteParts([...ancestors, ...(ownPath ? [ownPath] : [])]);
}

export function detectFramework(config: JourneyConfig, cwd: string): Framework {
  if (config.framework) return config.framework;
  const appDirectory = path.resolve(cwd, config.appDirectory ?? path.join(config.sourceRoot, "app"));
  if (fs.existsSync(appDirectory)) return "next";
  const packagePath = path.resolve(cwd, "package.json");
  if (fs.existsSync(packagePath)) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (packageJson.dependencies?.vite || packageJson.devDependencies?.vite) return "vite";
  }
  throw new Error(
    "Could not detect a supported frontend. Expected a Next.js app directory or a package.json containing Vite. Set framework explicitly if detection is ambiguous.",
  );
}

export function discoverNextRoutes(project: Project, config: JourneyConfig, cwd: string): RouteSource[] {
  const labels = config.areaLabels ?? {};
  const appDirectory = path.resolve(cwd, config.appDirectory ?? path.join(config.sourceRoot, "app"));
  const sources: RouteSource[] = [];
  const rootLayout = project.getSourceFile(path.join(appDirectory, "layout.tsx"));
  if (rootLayout) sources.push({ area: "Global shell", file: rootLayout, kind: "layout", path: "Global shell" });
  for (const file of project
    .getSourceFiles()
    .filter((source) => source.getBaseName() === "page.tsx" && source.getFilePath().startsWith(`${appDirectory}${path.sep}`))
    .sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()))) {
    const route = nextRoute(appDirectory, file.getFilePath());
    sources.push({ area: areaForRoute(route, labels), file, kind: "page", path: route });
  }
  for (const file of project
    .getSourceFiles()
    .filter(
      (source) =>
        source.getBaseName() === "layout.tsx" &&
        source.getFilePath().startsWith(`${appDirectory}${path.sep}`) &&
        source !== rootLayout,
    )
    .sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()))) {
    const route = nextRoute(appDirectory, file.getFilePath());
    sources.push({ area: areaForRoute(route, labels), file, kind: "layout", path: `${route} shared layout` });
  }
  if (!sources.some((source) => source.kind === "page")) {
    throw new Error(`Next.js adapter found no page.tsx routes under ${appDirectory}`);
  }
  return sources;
}

export function discoverViteRoutes(project: Project, config: JourneyConfig, cwd: string): RouteSource[] {
  const labels = config.areaLabels ?? {};
  const sourceRoot = path.resolve(cwd, config.sourceRoot);
  const routes = new Map<string, RouteSource>();
  for (const file of project.getSourceFiles().filter((source) => source.getFilePath().startsWith(sourceRoot))) {
    for (const node of file.getDescendants().filter(Node.isJsxSelfClosingElement)) {
      if (node.getTagNameNode().getText().split(".").at(-1) !== "Route") continue;
      const routePath = jsxRoutePath(node);
      const target = routeElementSource(node);
      if (!routePath || !target) continue;
      routes.set(routePath, { area: areaForRoute(routePath, labels), file: target, kind: "page", path: routePath });
    }
    for (const node of file.getDescendants().filter(Node.isObjectLiteralExpression)) {
      const routePath = objectRoutePath(node);
      const target = routeElementSource(node);
      if (!routePath || !target) continue;
      routes.set(routePath, { area: areaForRoute(routePath, labels), file: target, kind: "page", path: routePath });
    }
  }
  if (routes.size === 0) {
    throw new Error(
      "Vite adapter found no statically declared React Router routes. Supported forms are <Route path=\"...\" element={<Page />} /> and object routes with literal path plus element or Component.",
    );
  }
  return [...routes.values()].sort((left, right) => left.path.localeCompare(right.path));
}
