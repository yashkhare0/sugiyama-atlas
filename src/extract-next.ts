import { createHash } from "node:crypto";
import path from "node:path";

import {
  Node,
  Project,
  SyntaxKind,
  type JsxAttribute,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type JsxElement,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type SourceFile,
} from "ts-morph";

import type { Evidence, InteractionKind, JourneyConfig, JourneyInteraction, JourneyManifest, JourneyRoute } from "./types.ts";
import { buildJourneyGraph } from "./build-graph.ts";
import { detectFramework, discoverNextRoutes, discoverViteRoutes, type Framework } from "./framework-adapters.ts";

const EVENT_ATTRIBUTES = new Set([
  "onClick",
  "onSubmit",
  "onChange",
  "onCheckedChange",
  "onOpenChange",
  "onSelect",
  "onValueChange",
]);

const INTERACTIVE_TAGS = new Set(["button", "form", "input", "select", "textarea"]);
const INTERACTIVE_COMPONENTS = /(?:^Tab$|TabTrigger$|TabsTrigger$|Button$|DialogTrigger$|MenuItem$|SelectItem$|Checkbox$|Switch$)/;
const EVENT_CONTAINER_COMPONENTS = new Set([
  "Accordion",
  "Collapsible",
  "Combobox",
  "Dialog",
  "Drawer",
  "DropdownMenu",
  "Popover",
  "RadioGroup",
  "Select",
  "Sheet",
  "Tabs",
  "ToggleGroup",
  "Tooltip",
]);

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function attribute(element: JsxOpeningElement | JsxSelfClosingElement, name: string): JsxAttribute | undefined {
  const property = element.getAttribute(name);
  return property && Node.isJsxAttribute(property) ? property : undefined;
}

function attributeValue(element: JsxOpeningElement | JsxSelfClosingElement, name: string): string | undefined {
  const property = attribute(element, name);
  if (!property) return undefined;
  const initializer = property.getInitializer();
  if (!initializer) return "true";
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralValue().trim();
  if (Node.isJsxExpression(initializer)) {
    const expression = initializer.getExpression();
    if (!expression) return undefined;
    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.getLiteralValue().trim();
    }
    return expression.getText().trim();
  }
  return initializer.getText().trim();
}

function staticAttributeValue(element: JsxOpeningElement | JsxSelfClosingElement, name: string): string | undefined {
  const property = attribute(element, name);
  const initializer = property?.getInitializer();
  if (!initializer) return undefined;
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralValue().trim();
  if (!Node.isJsxExpression(initializer)) return undefined;
  const expression = initializer.getExpression();
  if (expression && (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression))) {
    return expression.getLiteralValue().trim();
  }
  return undefined;
}

function declarationInitializer(node: Node): Node | undefined {
  if (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node)) return node.getInitializer();
  if (Node.isPropertyDeclaration(node)) return node.getInitializer();
  return undefined;
}

function expressionInitializer(expression: Node): Node | undefined {
  if (Node.isParenthesizedExpression(expression) || Node.isAsExpression(expression) || Node.isSatisfiesExpression(expression)) {
    return expressionInitializer(expression.getExpression());
  }
  for (const declaration of expressionDeclarations(expression)) {
    const initializer = declarationInitializer(declaration);
    if (initializer) return initializer;
  }
  return undefined;
}

function expressionDeclarations(node: Node): Node[] {
  const symbol = node.getSymbol();
  if (!symbol) return [];
  const aliased = symbol.getAliasedSymbol();
  return [...symbol.getDeclarations(), ...(aliased?.getDeclarations() ?? [])];
}

function objectPropertyInitializer(expression: Node, propertyName: string, seen: Set<string>): Node | undefined {
  const key = `${expression.getSourceFile().getFilePath()}:${expression.getStart()}:${propertyName}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  if (Node.isParenthesizedExpression(expression) || Node.isAsExpression(expression) || Node.isSatisfiesExpression(expression)) {
    return objectPropertyInitializer(expression.getExpression(), propertyName, seen);
  }
  if (Node.isObjectLiteralExpression(expression)) {
    const property = expression.getProperty(propertyName);
    return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
  }
  if (Node.isPropertyAccessExpression(expression)) {
    const parentInitializer = objectPropertyInitializer(
      expression.getExpression(),
      expression.getName(),
      new Set(seen),
    );
    if (parentInitializer) return objectPropertyInitializer(parentInitializer, propertyName, new Set(seen));
  }
  if (Node.isIdentifier(expression)) {
    for (const declaration of expression.getSourceFile().getImportDeclarations()) {
      const dependency = declaration.getModuleSpecifierSourceFile();
      if (!dependency) continue;
      for (const namedImport of declaration.getNamedImports()) {
        const localName = namedImport.getAliasNode()?.getText() ?? namedImport.getName();
        if (localName !== expression.getText()) continue;
        const importedName = namedImport.getName();
        const imported = dependency.getVariableDeclaration(importedName);
        const initializer = imported?.getInitializer();
        if (initializer) return objectPropertyInitializer(initializer, propertyName, new Set(seen));
      }
    }
  }
  for (const declaration of expressionDeclarations(expression)) {
    const initializer = declarationInitializer(declaration);
    if (initializer) {
      const property = objectPropertyInitializer(initializer, propertyName, seen);
      if (property) return property;
    }
  }
  return undefined;
}

function staticExpressionValue(
  expression: Node | undefined,
  seen = new Set<string>(),
  bindings = new Map<string, string>(),
): string | undefined {
  if (!expression) return undefined;
  if (Node.isIdentifier(expression) && bindings.has(expression.getText())) return bindings.get(expression.getText());
  const literalValue = expression.getType().getLiteralValue();
  if (typeof literalValue === "string") return literalValue.trim();
  const key = `${expression.getSourceFile().getFilePath()}:${expression.getStart()}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.getLiteralValue().trim();
  }
  if (Node.isParenthesizedExpression(expression) || Node.isAsExpression(expression) || Node.isSatisfiesExpression(expression)) {
    return staticExpressionValue(expression.getExpression(), seen, bindings);
  }
  if (Node.isTemplateExpression(expression)) {
    let value = expression.getHead().getLiteralText();
    for (const span of expression.getTemplateSpans()) {
      const resolved = staticExpressionValue(span.getExpression(), new Set(seen), bindings);
      value += resolved ?? `\${${span.getExpression().getText()}}`;
      value += span.getLiteral().getLiteralText();
    }
    return value.trim();
  }
  if (Node.isBinaryExpression(expression) && expression.getOperatorToken().getText() === "+") {
    const left = staticExpressionValue(expression.getLeft(), new Set(seen), bindings);
    const right = staticExpressionValue(expression.getRight(), new Set(seen), bindings);
    if (left !== undefined && right !== undefined) return `${left}${right}`.trim();
  }
  if (Node.isConditionalExpression(expression)) {
    const whenTrue = staticExpressionValue(expression.getWhenTrue(), new Set(seen), bindings);
    const whenFalse = staticExpressionValue(expression.getWhenFalse(), new Set(seen), bindings);
    if (whenTrue !== undefined && whenTrue === whenFalse) return whenTrue;
  }
  if (Node.isCallExpression(expression)) {
    const values = new Set<string>();
    for (const declaration of resolvedDeclarations(expression.getExpression())) {
      const callable = callableDeclaration(declaration);
      if (!callable) continue;
      const callBindings = new Map(bindings);
      callable.getParameters().forEach((parameter, index) => {
        const argument = expression.getArguments()[index];
        const value = staticExpressionValue(argument, new Set(seen), bindings);
        if (value !== undefined && Node.isIdentifier(parameter.getNameNode())) {
          callBindings.set(parameter.getName(), value);
        }
      });
      if (Node.isArrowFunction(callable) && !Node.isBlock(callable.getBody())) {
        const value = staticExpressionValue(callable.getBody(), new Set(seen), callBindings);
        if (value !== undefined) values.add(value);
      }
      for (const returned of callable.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
        const value = staticExpressionValue(returned.getExpression(), new Set(seen), callBindings);
        if (value !== undefined) values.add(value);
      }
    }
    if (values.size === 1) return [...values][0];
  }
  if (Node.isPropertyAccessExpression(expression)) {
    let rootExpression: Node = expression;
    while (Node.isPropertyAccessExpression(rootExpression)) rootExpression = rootExpression.getExpression();
    if (
      Node.isIdentifier(rootExpression) &&
      expressionDeclarations(rootExpression).some((declaration) => Node.isParameterDeclaration(declaration))
    ) {
      return undefined;
    }
    const initializer = objectPropertyInitializer(expression.getExpression(), expression.getName(), new Set(seen));
    const resolved = staticExpressionValue(initializer, new Set(seen), bindings);
    if (resolved !== undefined) return resolved;
  }
  for (const declaration of expressionDeclarations(expression)) {
    const resolved = staticExpressionValue(declarationInitializer(declaration), new Set(seen), bindings);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function staticResolvedAttributeValue(
  element: JsxOpeningElement | JsxSelfClosingElement,
  name: string,
): string | undefined {
  const initializer = attribute(element, name)?.getInitializer();
  if (!initializer) return undefined;
  if (Node.isStringLiteral(initializer)) return initializer.getLiteralValue().trim();
  if (!Node.isJsxExpression(initializer)) return undefined;
  const expression = initializer.getExpression();
  const direct = staticExpressionValue(expression);
  if (direct !== undefined || !expression) return direct;
  const callSiteValues = new Set(
    componentPropExpressions(expression)
      .map((value) => staticExpressionValue(value))
      .filter((value): value is string => value !== undefined),
  );
  return callSiteValues.size === 1 ? [...callSiteValues][0] : undefined;
}

function staticExpressionCandidates(expression: Node | undefined, seen = new Set<string>()): string[] {
  if (!expression) return [];
  const key = `${expression.getSourceFile().getFilePath()}:${expression.getStart()}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const direct = staticExpressionValue(expression);
  if (direct !== undefined) return [direct];
  if (Node.isParenthesizedExpression(expression) || Node.isAsExpression(expression) || Node.isSatisfiesExpression(expression)) {
    return staticExpressionCandidates(expression.getExpression(), seen);
  }
  if (Node.isConditionalExpression(expression)) {
    return [
      ...staticExpressionCandidates(expression.getWhenTrue(), new Set(seen)),
      ...staticExpressionCandidates(expression.getWhenFalse(), new Set(seen)),
    ];
  }
  if (Node.isBinaryExpression(expression) && ["??", "||"].includes(expression.getOperatorToken().getText())) {
    return [
      ...staticExpressionCandidates(expression.getLeft(), new Set(seen)),
      ...staticExpressionCandidates(expression.getRight(), new Set(seen)),
    ];
  }
  if (Node.isCallExpression(expression)) {
    const values: string[] = [];
    for (const declaration of resolvedDeclarations(expression.getExpression())) {
      const callable = callableDeclaration(declaration);
      if (!callable) continue;
      for (const returned of callable.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
        values.push(...staticExpressionCandidates(returned.getExpression(), new Set(seen)));
      }
    }
    return values;
  }
  if (Node.isPropertyAccessExpression(expression)) {
    const propertyName = expression.getName();
    const base = expressionInitializer(expression.getExpression()) ?? expression.getExpression();
    const objectLiterals = Node.isCallExpression(base)
      ? resolvedDeclarations(base.getExpression()).flatMap((declaration) => {
          const callable = callableDeclaration(declaration);
          return callable?.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression) ?? [];
        })
      : [base, ...base.getDescendants()].filter(Node.isObjectLiteralExpression);
    const values: string[] = [];
    for (const objectLiteral of objectLiterals) {
      const property = objectLiteral.getProperty(propertyName);
      if (property && Node.isPropertyAssignment(property)) {
        values.push(...staticExpressionCandidates(property.getInitializer(), new Set(seen)));
      }
    }
    if (values.length > 0) return values;
  }
  const values: string[] = [];
  for (const declaration of expressionDeclarations(expression)) {
    values.push(...staticExpressionCandidates(declarationInitializer(declaration), new Set(seen)));
  }
  for (const callSite of componentPropExpressions(expression)) {
    values.push(...staticExpressionCandidates(callSite, new Set(seen)));
  }
  return [...new Set(values)];
}

function attributeDestinationCandidates(element: JsxOpeningElement | JsxSelfClosingElement): string[] {
  const initializer = attribute(element, "href")?.getInitializer();
  if (!initializer) return [];
  if (Node.isStringLiteral(initializer)) return [initializer.getLiteralValue().trim()];
  if (!Node.isJsxExpression(initializer)) return [];
  return [...new Set(staticExpressionCandidates(initializer.getExpression()))].sort();
}

function staticText(element: JsxElement): string | undefined {
  const values: string[] = [];
  const visit = (children: Node[]) => {
    for (const child of children) {
      if (Node.isJsxElement(child)) {
        const opening = child.getOpeningElement();
        const nestedTag = tagName(opening);
        const nestedInteractive =
          Boolean(attribute(opening, "href")) ||
          [...EVENT_ATTRIBUTES].some((name) => attribute(opening, name)) ||
          INTERACTIVE_TAGS.has(nestedTag);
        if (!nestedInteractive) visit(child.getJsxChildren());
        continue;
      }
      if (Node.isJsxText(child)) {
        const value = child.getText().replace(/\s+/g, " ").trim();
        if (value) values.push(value);
        continue;
      }
      if (Node.isJsxExpression(child)) {
        const expression = child.getExpression();
        if (expression && (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression))) {
          values.push(expression.getLiteralValue().trim());
        } else if (expression && Node.isConditionalExpression(expression)) {
          const alternatives = [expression.getWhenTrue(), expression.getWhenFalse()]
            .map((branch) => staticExpressionValue(branch))
            .filter((value): value is string => Boolean(value));
          if (alternatives.length > 0) values.push([...new Set(alternatives)].join(" / "));
        }
      }
    }
  };
  visit(element.getJsxChildren());
  const label = values.join(" ").trim();
  return label || undefined;
}

function associatedLabel(
  node: JsxElement | JsxSelfClosingElement,
  opening: JsxOpeningElement | JsxSelfClosingElement,
): string | undefined {
  const parentLabel = node.getAncestors().find(
    (ancestor): ancestor is JsxElement =>
      Node.isJsxElement(ancestor) && tagName(ancestor.getOpeningElement()) === "label",
  );
  const parentText = parentLabel && staticText(parentLabel);
  if (parentText) return parentText;
  const tooltip = node.getAncestors().find(
    (ancestor): ancestor is JsxElement =>
      Node.isJsxElement(ancestor) && /Tooltip$/.test(tagName(ancestor.getOpeningElement())),
  );
  if (tooltip) {
    const tooltipOpening = tooltip.getOpeningElement();
    const tooltipLabel =
      staticResolvedAttributeValue(tooltipOpening, "label") ??
      staticResolvedAttributeValue(tooltipOpening, "title") ??
      staticText(tooltip);
    if (tooltipLabel) return tooltipLabel;
  }
  const idValue = staticAttributeValue(opening, "id");
  if (idValue) {
    for (const label of node.getSourceFile().getDescendantsOfKind(SyntaxKind.JsxElement)) {
      if (tagName(label.getOpeningElement()) !== "label") continue;
      if (staticAttributeValue(label.getOpeningElement(), "htmlFor") !== idValue) continue;
      const text = staticText(label);
      if (text) return text;
    }
  }
  const name = staticAttributeValue(opening, "name");
  if (name) return humanizeDynamicLabel(name);
  let container: Node | undefined = node.getParent();
  for (let depth = 0; container && depth < 3; depth += 1, container = container.getParent()) {
    if (!Node.isJsxElement(container)) continue;
    const labels = container
      .getDescendantsOfKind(SyntaxKind.JsxElement)
      .filter((candidate) => tagName(candidate.getOpeningElement()) === "label")
      .map((candidate) => staticText(candidate))
      .filter((value): value is string => Boolean(value));
    if (labels.length === 1) return labels[0];
  }
  return undefined;
}

function dynamicText(element: JsxElement): string | undefined {
  const semanticExpression = (expression: Node): string | undefined => {
    if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression)) return expression.getText();
    if (Node.isParenthesizedExpression(expression)) return semanticExpression(expression.getExpression());
    if (Node.isBinaryExpression(expression)) {
      return semanticExpression(expression.getLeft()) ?? semanticExpression(expression.getRight());
    }
    if (Node.isConditionalExpression(expression)) {
      const whenTrue = semanticExpression(expression.getWhenTrue());
      const whenFalse = semanticExpression(expression.getWhenFalse());
      return whenTrue === whenFalse ? whenTrue : whenTrue ?? whenFalse;
    }
    if (Node.isCallExpression(expression)) {
      const callee = expression.getExpression();
      if (Node.isIdentifier(callee) || Node.isPropertyAccessExpression(callee)) return callee.getText();
    }
    return undefined;
  };
  const visit = (children: Node[]): string | undefined => {
    for (const child of children) {
      if (Node.isJsxExpression(child)) {
        const expression = child.getExpression();
        if (expression) {
          const value = semanticExpression(expression);
          if (value) return value;
        }
      }
      if (Node.isJsxElement(child)) {
        const nested = visit(child.getJsxChildren());
        if (nested) return nested;
      }
    }
    return undefined;
  };
  return visit(element.getJsxChildren());
}

function humanizeIdentifier(value: string): string | undefined {
  const matches = [...value.matchAll(/\b(?:on|handle|set)([A-Z][A-Za-z0-9]*)\b/g)];
  const candidate = matches[0]?.[1];
  if (!candidate) return undefined;
  return candidate
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^is /i, "")
    .replace(/^selected /i, "Select ")
    .replace(/^open$/i, "Open")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function humanizeDynamicLabel(value: string | undefined): string | undefined {
  if (!value || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value)) return value;
  const parts = value.split(".");
  if (parts.at(-1)?.toLowerCase() === "url") parts.pop();
  const label = parts
    .flatMap((part) => part.split("_"))
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .filter((part) => !/^(?:format|get|build|render|resolve)$/i.test(part))
    .map((part) => (part.toLowerCase() === "id" ? "ID" : part.toLowerCase()))
    .join(" ")
    .replace(/^./, (letter) => letter.toUpperCase());
  return /^(?:label|title|name|value|href)$/i.test(label) ? undefined : label;
}

function isSourceLabelExpression(value: string | undefined): boolean {
  return Boolean(value && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value) && humanizeDynamicLabel(value));
}

function defaultValueForIdentifier(node: Node, identifier: string | undefined): string | undefined {
  if (!identifier || !/^[A-Za-z_$][\w$]*$/.test(identifier)) return undefined;
  for (const ancestor of node.getAncestors()) {
    if (
      !Node.isFunctionDeclaration(ancestor) &&
      !Node.isArrowFunction(ancestor) &&
      !Node.isFunctionExpression(ancestor)
    ) {
      continue;
    }
    for (const parameter of ancestor.getParameters()) {
      const nameNode = parameter.getNameNode();
      if (!Node.isObjectBindingPattern(nameNode)) continue;
      for (const element of nameNode.getElements()) {
        if (element.getName() !== identifier) continue;
        const initializer = element.getInitializer();
        if (initializer && (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer))) {
          return initializer.getLiteralValue().trim();
        }
      }
    }
    break;
  }
  return undefined;
}

function handlerFrom(sourceExpression: string): string | undefined {
  if (!sourceExpression) return undefined;
  const expression = sourceExpression
    .replace(/^[A-Za-z]+=/, "")
    .replace(/^\([^)]*\)\s*=>\s*/, "")
    .replace(/^[A-Za-z_$][\w$]*\s*=>\s*/, "")
    .replace(/^\{\s*(?:void\s+)?/, "")
    .replace(/;?\s*\}$/, "")
    .trim();
  return expression ? expression.replace(/\s+/g, " ").slice(0, 4000) : undefined;
}

function tagName(element: JsxOpeningElement | JsxSelfClosingElement): string {
  return element.getTagNameNode().getText();
}

function componentOpensNewTab(element: JsxOpeningElement | JsxSelfClosingElement, seen = new Set<string>()): boolean {
  const symbol = element.getTagNameNode().getSymbol();
  if (!symbol) return false;
  return symbol.getDeclarations().some((declaration) => {
    const key = `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return declaration
      .getDescendants()
      .filter(
        (node): node is JsxOpeningElement | JsxSelfClosingElement =>
          Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node),
      )
      .some(
        (node) =>
          (tagName(node) === "a" && staticAttributeValue(node, "target") === "_blank") ||
          (/^[A-Z]/.test(tagName(node)) && componentOpensNewTab(node, seen)),
      );
  });
}

function kindFor(tag: string, href: string | undefined, events: string[], target: string | undefined): InteractionKind {
  if (href) return target === "_blank" || /^(https?:|mailto:)/.test(href) ? "external-link" : "link";
  if (tag === "form" || events.includes("onSubmit")) return "form";
  if (["input", "select", "textarea"].includes(tag)) return "input";
  if (tag === "button" || tag.endsWith("Button")) return "button";
  if (events.some((event) => ["onChange", "onCheckedChange", "onSelect", "onValueChange"].includes(event))) {
    return "selection";
  }
  return "trigger";
}

function conciseExpression(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\s+/g, " ").slice(0, 180);
}

function componentCallableName(callable: Node): string | undefined {
  if (Node.isFunctionDeclaration(callable)) return callable.getName();
  const declaration = callable.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return declaration?.getName();
}

function parameterProp(expression: Node): { callable: Node; prop: string } | undefined {
  const declarations = resolvedDeclarations(expression);
  for (const declaration of declarations) {
    if (Node.isBindingElement(declaration)) {
      const parameter = declaration.getFirstAncestorByKind(SyntaxKind.Parameter);
      const callable = parameter?.getParent();
      if (callable && (Node.isFunctionDeclaration(callable) || Node.isArrowFunction(callable) || Node.isFunctionExpression(callable))) {
        return { callable, prop: declaration.getPropertyNameNode()?.getText() ?? declaration.getName() };
      }
    }
    if (Node.isParameterDeclaration(declaration) && Node.isPropertyAccessExpression(expression)) {
      const callable = declaration.getParent();
      if (Node.isFunctionDeclaration(callable) || Node.isArrowFunction(callable) || Node.isFunctionExpression(callable)) {
        return { callable, prop: expression.getName() };
      }
    }
  }
  return undefined;
}

function expressionFromAttribute(property: JsxAttribute): Node | undefined {
  const initializer = property.getInitializer();
  if (!initializer) return undefined;
  if (Node.isJsxExpression(initializer)) return initializer.getExpression();
  return initializer;
}

const componentPropCache = new WeakMap<Project, Map<string, Node[]>>();

function callableKey(callable: Node): string {
  return `${callable.getSourceFile().getFilePath()}:${callable.getStart()}`;
}

function componentPropIndex(project: Project): Map<string, Node[]> {
  const cached = componentPropCache.get(project);
  if (cached) return cached;
  const index = new Map<string, Node[]>();
  for (const sourceFile of project.getSourceFiles()) {
    for (const opening of [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ]) {
      for (const declaration of resolvedDeclarations(opening.getTagNameNode())) {
        const callable = callableDeclaration(declaration);
        if (!callable) continue;
        for (const property of opening.getAttributes().filter(Node.isJsxAttribute)) {
          const value = expressionFromAttribute(property);
          if (!value) continue;
          const key = `${callableKey(callable)}:${property.getNameNode().getText()}`;
          const values = index.get(key) ?? [];
          values.push(value);
          index.set(key, values);
        }
      }
    }
  }
  componentPropCache.set(project, index);
  return index;
}

function componentPropExpressions(expression: Node): Node[] {
  const parameter = parameterProp(expression);
  if (!parameter || !componentCallableName(parameter.callable)) return [];
  return componentPropIndex(expression.getProject()).get(`${callableKey(parameter.callable)}:${parameter.prop}`) ?? [];
}

function resolveHandlerExpression(expression: Node, seen = new Set<string>()): string | undefined {
  const key = `${expression.getSourceFile().getFilePath()}:${expression.getStart()}`;
  if (seen.has(key)) return undefined;
  seen.add(key);

  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    const parts = [expression.getText()];
    for (const call of expression.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isIdentifier(callee) && !Node.isPropertyAccessExpression(callee)) continue;
      if (/^(?:set[A-Z]|router\.|toast\.|Math\.|Object\.|Array\.)/.test(callee.getText())) continue;
      const resolved = resolveHandlerExpression(callee, new Set(seen));
      if (resolved && resolved !== callee.getText()) parts.push(resolved);
    }
    return parts.join("; ").slice(0, 4000);
  }
  if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression)) {
    for (const declaration of resolvedDeclarations(expression)) {
      if (Node.isFunctionDeclaration(declaration) || Node.isMethodDeclaration(declaration)) {
        return declaration.getBody()?.getText() ?? expression.getText();
      }
      if (Node.isVariableDeclaration(declaration)) {
        const value = declaration.getInitializer();
        if (value) {
          const resolved = resolveHandlerExpression(value, new Set(seen));
          if (resolved) return resolved;
        }
      }
    }

    if (Node.isIdentifier(expression)) {
      const variableDeclarations = expression
        .getProject()
        .getSourceFiles()
        .map((sourceFile) => sourceFile.getVariableDeclaration(expression.getText()))
        .filter((declaration): declaration is NonNullable<typeof declaration> => Boolean(declaration));
      if (variableDeclarations.length === 1) {
        const value = variableDeclarations[0].getInitializer();
        if (value) {
          const resolved = resolveHandlerExpression(value, new Set(seen));
          if (resolved) return resolved;
        }
      }
      const functionDeclarations = expression
        .getProject()
        .getSourceFiles()
        .map((sourceFile) => sourceFile.getFunction(expression.getText()))
        .filter((declaration): declaration is NonNullable<typeof declaration> => Boolean(declaration));
      if (functionDeclarations.length === 1) {
        return functionDeclarations[0].getBody()?.getText() ?? expression.getText();
      }
    }

    const callSiteExpressions = componentPropExpressions(expression);
    if (callSiteExpressions.length > 0) {
      const values = new Set<string>();
      for (const value of callSiteExpressions) {
        const resolved = resolveHandlerExpression(value, new Set(seen)) ?? value.getText();
        if (resolved) values.add(resolved);
      }
      if (values.size === 1) return [...values][0];
    }
  }
  return undefined;
}

function eventHandlerExpression(
  element: JsxOpeningElement | JsxSelfClosingElement,
  event: string,
): string | undefined {
  const initializer = attribute(element, event)?.getInitializer();
  if (!initializer || !Node.isJsxExpression(initializer)) return attributeValue(element, event);
  const expression = initializer.getExpression();
  if (!expression) return undefined;
  return resolveHandlerExpression(expression) ?? expression.getText();
}

function destinationFrom(
  element: JsxOpeningElement | JsxSelfClosingElement,
  events: string[],
  sourceExpression?: string,
): string | undefined {
  const href = staticResolvedAttributeValue(element, "href") ?? attributeValue(element, "href");
  if (href) return href;
  const expression = sourceExpression ?? events.map((event) => eventHandlerExpression(element, event)).join("; ");
  const match = expression.match(/\brouter\.(?:push|replace)\((?:`([^`]+)`|["']([^"']+)["']|([^,)]+))/);
  if (match) return (match[1] ?? match[2] ?? match[3])?.trim();
  return undefined;
}

type StateOwnershipIndex = {
  ownersByState: Map<string, Set<string>>;
  statesBySetter: Map<string, Set<string>>;
};

const stateOwnershipCache = new WeakMap<SourceFile, StateOwnershipIndex>();

function stateOwnershipIndex(sourceFile: SourceFile): StateOwnershipIndex {
  const cached = stateOwnershipCache.get(sourceFile);
  if (cached) return cached;
  const index: StateOwnershipIndex = { ownersByState: new Map(), statesBySetter: new Map() };
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = declaration.getNameNode();
    if (!Node.isArrayBindingPattern(name) || name.getElements().length < 2) continue;
    const stateElement = name.getElements()[0];
    const setterElement = name.getElements()[1];
    if (!stateElement || !setterElement || !Node.isBindingElement(stateElement) || !Node.isBindingElement(setterElement)) {
      continue;
    }
    const stateName = stateElement.getName();
    const setterName = setterElement.getName();
    if (!stateName || !setterName) continue;
    const states = index.statesBySetter.get(setterName) ?? new Set<string>();
    states.add(stateName);
    index.statesBySetter.set(setterName, states);
  }
  for (const opening of [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ]) {
    const openValue = attributeValue(opening, "open");
    if (!openValue) continue;
    for (const stateName of new Set([...index.statesBySetter.values()].flatMap((states) => [...states]))) {
      if (!new RegExp(`\\b${stateName}\\b`).test(openValue)) continue;
      const owner = tagName(opening).replace(/(?:Root|Content)$/, "");
      if (!/^(?:AlertDialog|Dialog|Drawer|DropdownMenu|Popover|Sheet)$/.test(owner)) continue;
      const owners = index.ownersByState.get(stateName) ?? new Set<string>();
      owners.add(owner);
      index.ownersByState.set(stateName, owners);
    }
  }
  stateOwnershipCache.set(sourceFile, index);
  return index;
}

function controlledStateOutcome(node: Node, sourceExpression: string): string | undefined {
  const index = stateOwnershipIndex(node.getSourceFile());
  const visibleOutcomes: string[] = [];
  const setterMatches = [...sourceExpression.matchAll(/\b(set[A-Z][A-Za-z0-9_$]*)\s*\(\s*([^)]*)/g)].map(
    (match) => ({ argument: match[2], setterName: match[1] }),
  );
  if (setterMatches.length === 0) {
    const setterReference = sourceExpression.match(/(?:^|=)\s*(set[A-Z][A-Za-z0-9_$]*)\s*$/);
    if (setterReference) setterMatches.push({ argument: "__event__", setterName: setterReference[1] });
  }
  for (const setterReference of sourceExpression.matchAll(/\b(set[A-Z][A-Za-z0-9_$]*)\b(?!\s*\()/g)) {
    if (!setterMatches.some((match) => match.setterName === setterReference[1])) {
      setterMatches.push({ argument: "__event__", setterName: setterReference[1] });
    }
  }
  for (const { argument, setterName } of setterMatches) {
    const stateNames = index.statesBySetter.get(setterName) ?? new Set<string>();
    if (stateNames.size !== 1) continue;
    const stateName = [...stateNames][0];
    const owners = index.ownersByState.get(stateName) ?? new Set<string>();
    const closes = /^(?:false|null|undefined)$/.test(argument.trim());
    const toggles = new RegExp(`(?:!\\s*${stateName}|=>\\s*!|\\b${stateName}\\s*=>)`).test(argument);
    if (owners.size === 1) {
      const owner = [...owners][0].replace(/([a-z])([A-Z])/g, "$1 $2");
      return `${owner} ${closes ? "closes" : toggles ? "opens or closes" : "opens"}`;
    }

    const controlsRenderedJsx = node
      .getSourceFile()
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .some(
        (identifier) =>
          identifier.getText() === stateName &&
          Boolean(identifier.getFirstAncestorByKind(SyntaxKind.JsxExpression)),
      );
    if (!controlsRenderedJsx) continue;
    const subject = stateName
      .replace(/^(?:is|has|show)(?=[A-Z])/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/^selected /i, "Selected ")
      .toLowerCase()
      .replace(/^./, (letter) => letter.toUpperCase());
    visibleOutcomes.push(
      /^(?:is|has|show)[A-Z]/.test(stateName)
        ? `${subject} ${closes ? "becomes inactive" : toggles ? "toggles" : "becomes active"}`
        : `${subject} changes`,
    );
  }
  return visibleOutcomes[0];
}

function conditionsFor(node: Node): string[] {
  const conditions: string[] = [];
  for (const ancestor of node.getAncestors()) {
    if (Node.isConditionalExpression(ancestor)) {
      conditions.push(conciseExpression(ancestor.getCondition().getText()) ?? "conditional");
    } else if (Node.isBinaryExpression(ancestor) && ancestor.getOperatorToken().getText() === "&&") {
      conditions.push(conciseExpression(ancestor.getLeft().getText()) ?? "conditional");
    } else if (Node.isJsxElement(ancestor)) {
      const opening = ancestor.getOpeningElement();
      if (/TabPanel$/.test(tagName(opening))) {
        const value = staticAttributeValue(opening, "value");
        if (value) conditions.push(`Tab is ${value}`);
      } else if (/(?:Dialog|Drawer|Popover|Sheet)Content$/.test(tagName(opening))) {
        conditions.push(`${tagName(opening).replace(/Content$/, "")} is open`);
      }
    }
    if (conditions.length === 3) break;
  }
  return [...new Set(conditions)].sort();
}

function stableId(parts: string[]): string {
  return `interaction-${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12)}`;
}

function callableDeclaration(node: Node): FunctionDeclaration | ArrowFunction | FunctionExpression | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) return initializer;
  }
  return undefined;
}

function resolvedDeclarations(node: Node): Node[] {
  const symbol = node.getSymbol();
  if (!symbol) return [];
  return [...symbol.getDeclarations(), ...(symbol.getAliasedSymbol()?.getDeclarations() ?? [])];
}

function belongsToRenderScope(node: Node, scope: Node): boolean {
  for (const ancestor of node.getAncestors()) {
    if (ancestor === scope) return true;
    if (Node.isFunctionDeclaration(ancestor)) return false;
    if (Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)) {
      if (ancestor.getFirstAncestorByKind(SyntaxKind.JsxAttribute)) return false;
      const jsxExpression = ancestor.getParentIfKind(SyntaxKind.JsxExpression);
      if (jsxExpression?.getParentIfKind(SyntaxKind.JsxElement)) continue;
      const call = ancestor.getParentIfKind(SyntaxKind.CallExpression);
      const callee = call?.getExpression();
      if (!callee || !Node.isPropertyAccessExpression(callee) || callee.getName() !== "map") return false;
    }
  }
  return false;
}

function defaultRenderScope(entry: SourceFile): Node | undefined {
  const direct = entry.getFunctions().find((declaration) => declaration.isDefaultExport());
  if (direct) return direct;
  for (const declaration of entry.getDefaultExportSymbol()?.getDeclarations() ?? []) {
    const callable = callableDeclaration(declaration);
    if (callable) return callable;
  }
  const named = entry
    .getExportSymbols()
    .flatMap((symbol) => symbol.getDeclarations())
    .map(callableDeclaration)
    .filter((declaration): declaration is NonNullable<ReturnType<typeof callableDeclaration>> => Boolean(declaration));
  return named.length === 1 ? named[0] : undefined;
}

function renderedJsx(entry: SourceFile, sourceRoot: string): Array<JsxElement | JsxSelfClosingElement> {
  const initial = defaultRenderScope(entry);
  if (!initial) return [];
  const pending: Node[] = [initial];
  const visited = new Set<string>();
  const result = new Map<string, JsxElement | JsxSelfClosingElement>();
  const withinSource = (node: Node) =>
    path.resolve(node.getSourceFile().getFilePath()).startsWith(`${path.resolve(sourceRoot)}${path.sep}`);

  while (pending.length > 0) {
    const scope = pending.pop();
    if (!scope) continue;
    const scopeKey = `${scope.getSourceFile().getFilePath()}:${scope.getStart()}`;
    if (visited.has(scopeKey)) continue;
    visited.add(scopeKey);

    const jsxNodes: Array<JsxElement | JsxSelfClosingElement> = [
      ...scope.getDescendantsOfKind(SyntaxKind.JsxElement),
      ...scope.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ].filter((node) => belongsToRenderScope(node, scope));
    for (const jsxNode of jsxNodes) {
      const key = `${jsxNode.getSourceFile().getFilePath()}:${jsxNode.getStart()}`;
      result.set(key, jsxNode);
      const opening = Node.isJsxElement(jsxNode) ? jsxNode.getOpeningElement() : jsxNode;
      if (!/^[A-Z]/.test(tagName(opening))) continue;
      if (attribute(opening, "href")) continue;
      for (const declaration of resolvedDeclarations(opening.getTagNameNode())) {
        const callable = callableDeclaration(declaration);
        if (callable && withinSource(callable)) pending.push(callable);
      }
    }

    for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (!belongsToRenderScope(call, scope)) continue;
      for (const declaration of resolvedDeclarations(call.getExpression())) {
        const callable = callableDeclaration(declaration);
        if (callable && withinSource(callable) && callable.getDescendantsOfKind(SyntaxKind.JsxElement).length > 0) {
          pending.push(callable);
        }
      }
    }
  }
  return [...result.values()].sort(
    (left, right) =>
      left.getSourceFile().getFilePath().localeCompare(right.getSourceFile().getFilePath()) || left.getStart() - right.getStart(),
  );
}

function redirectCandidates(expression: Node | undefined, seen = new Set<string>()): string[] {
  if (!expression) return [];
  const key = `${expression.getSourceFile().getFilePath()}:${expression.getStart()}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const direct = staticExpressionValue(expression);
  if (direct !== undefined) return [direct];
  if (Node.isAwaitExpression(expression) || Node.isParenthesizedExpression(expression)) {
    return redirectCandidates(expression.getExpression(), seen);
  }
  if (Node.isConditionalExpression(expression)) {
    return [
      ...redirectCandidates(expression.getWhenTrue(), new Set(seen)),
      ...redirectCandidates(expression.getWhenFalse(), new Set(seen)),
    ];
  }
  if (Node.isCallExpression(expression)) {
    const values: string[] = [];
    for (const declaration of resolvedDeclarations(expression.getExpression())) {
      const callable = callableDeclaration(declaration);
      if (!callable) continue;
      if (Node.isArrowFunction(callable) && !Node.isBlock(callable.getBody())) {
        values.push(...redirectCandidates(callable.getBody(), new Set(seen)));
      }
      for (const returned of callable.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
        values.push(...redirectCandidates(returned.getExpression(), new Set(seen)));
      }
    }
    return values;
  }
  return [];
}

function staticRedirects(entry: SourceFile): string[] {
  const scope = defaultRenderScope(entry);
  if (!scope) return [];
  const redirects = new Set<string>();
  for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!belongsToRenderScope(call, scope) || call.getExpression().getText() !== "redirect") continue;
    for (const destination of redirectCandidates(call.getArguments()[0])) redirects.add(destination);
  }
  return [...redirects].sort();
}

function unresolvedRedirects(entry: SourceFile, sourceRoot: string): Array<{ evidence: Evidence; expression: string }> {
  const scope = defaultRenderScope(entry);
  if (!scope) return [];
  const unresolved: Array<{ evidence: Evidence; expression: string }> = [];
  for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!belongsToRenderScope(call, scope) || call.getExpression().getText() !== "redirect") continue;
    const argument = call.getArguments()[0];
    if (!argument || redirectCandidates(argument).length > 0) continue;
    const position = entry.getLineAndColumnAtPos(call.getStart());
    unresolved.push({
      evidence: {
        column: position.column,
        file: toPosix(path.relative(sourceRoot, entry.getFilePath())),
        line: position.line,
      },
      expression: conciseExpression(argument.getText()) ?? argument.getText(),
    });
  }
  return unresolved;
}

function compareInteractions(left: JourneyInteraction, right: JourneyInteraction): number {
  return (
    left.evidence.file.localeCompare(right.evidence.file) ||
    left.evidence.line - right.evidence.line ||
    left.evidence.column - right.evidence.column ||
    left.id.localeCompare(right.id)
  );
}

function dynamicLabelExpression(
  node: JsxElement | JsxSelfClosingElement,
  opening: JsxOpeningElement | JsxSelfClosingElement,
): Node | undefined {
  for (const name of ["aria-label", "label", "title", "tooltip", "placeholder"]) {
    const property = attribute(opening, name);
    const expression = property && expressionFromAttribute(property);
    if (expression) return expression;
  }
  if (!Node.isJsxElement(node)) return undefined;
  return node
    .getJsxChildren()
    .filter(Node.isJsxExpression)
    .map((child) => child.getExpression())
    .find((expression) => Boolean(expression));
}

function staticCallSiteLabel(expression: Node | undefined): string | undefined {
  if (!expression) return undefined;
  const direct = staticExpressionValue(expression);
  if (direct !== undefined) return direct;
  const values = new Set(
    componentPropExpressions(expression)
      .map((value) => staticExpressionValue(value))
      .filter((value): value is string => Boolean(value)),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

function interactionFrom(
  node: JsxElement | JsxSelfClosingElement,
  sourceRoot: string,
  routes: string[],
): JourneyInteraction | undefined {
  const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
  if (
    attribute(opening, "asChild") &&
    Node.isJsxElement(node) &&
    node
      .getDescendants()
      .some(
        (descendant) =>
          (Node.isJsxOpeningElement(descendant) || Node.isJsxSelfClosingElement(descendant)) &&
          (Boolean(attribute(descendant, "href")) ||
            [...EVENT_ATTRIBUTES].some((name) => attribute(descendant, name)) ||
            INTERACTIVE_TAGS.has(tagName(descendant))),
      )
  ) {
    return undefined;
  }
  const tag = tagName(opening);
  const localComposite =
    /^[A-Z]/.test(tag) &&
    resolvedDeclarations(opening.getTagNameNode()).some((declaration) => {
      const callable = callableDeclaration(declaration);
      return Boolean(
        callable &&
          path.resolve(callable.getSourceFile().getFilePath()).startsWith(`${path.resolve(sourceRoot)}${path.sep}`),
      );
    });
  if (localComposite && !attribute(opening, "href")) return undefined;
  const href = staticResolvedAttributeValue(opening, "href") ?? attributeValue(opening, "href");
  const target = staticAttributeValue(opening, "target") ?? (componentOpensNewTab(opening) ? "_blank" : undefined);
  const events = [...EVENT_ATTRIBUTES].filter((name) => attribute(opening, name));
  const role = attributeValue(opening, "role");
  const componentControl = INTERACTIVE_COMPONENTS.test(tag);
  const isInteractive =
    Boolean(href) ||
    (events.length > 0 && !EVENT_CONTAINER_COMPONENTS.has(tag)) ||
    INTERACTIVE_TAGS.has(tag) ||
    componentControl ||
    role === "button" ||
    role === "link";
  if (!isInteractive) return undefined;

  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndColumnAtPos(opening.getStart());
  const relativeFile = toPosix(path.relative(sourceRoot, sourceFile.getFilePath()));
  const explicitLabel =
    staticAttributeValue(opening, "aria-label") ??
    staticAttributeValue(opening, "label") ??
    staticAttributeValue(opening, "title") ??
    staticAttributeValue(opening, "tooltip") ??
    staticAttributeValue(opening, "placeholder");
  const textLabel = Node.isJsxElement(node) ? staticText(node) : undefined;
  const associatedTextLabel = associatedLabel(node, opening);
  const dynamicLabel =
    attributeValue(opening, "aria-label") ??
    attributeValue(opening, "label") ??
    attributeValue(opening, "title") ??
    (Node.isJsxElement(node) ? dynamicText(node) : undefined);
  const nestedDynamicLabel = Node.isJsxElement(node) ? dynamicText(node) : undefined;
  const effectiveDynamicLabel = humanizeDynamicLabel(dynamicLabel) ? dynamicLabel : nestedDynamicLabel ?? dynamicLabel;
  const defaultDynamicLabel = defaultValueForIdentifier(node, dynamicLabel);
  const callSiteLabel =
    staticCallSiteLabel(dynamicLabelExpression(node, opening)) ??
    (Node.isJsxElement(node)
      ? staticCallSiteLabel(
          node
            .getJsxChildren()
            .filter(Node.isJsxExpression)
            .map((child) => child.getExpression())
            .find((expression) => Boolean(expression)),
        )
      : undefined);
  let sourceExpression = events.map((event) => `${event}=${eventHandlerExpression(opening, event)}`).join("; ");
  if (!sourceExpression) {
    const trigger = node
      .getAncestors()
      .find(
        (ancestor): ancestor is JsxElement =>
          Node.isJsxElement(ancestor) &&
          /(?:Collapsible|Dialog|Popover|DropdownMenu|Sheet|Drawer)Trigger$/.test(
            tagName(ancestor.getOpeningElement()),
          ),
      );
    if (trigger) sourceExpression = `onClick=toggle${tagName(trigger.getOpeningElement()).replace(/Trigger$/, "")}()`;
  }
  if (
    !href &&
    sourceExpression &&
    events.every((event) =>
      /(?:^|=>\s*)(?:event|e)\.(?:stopPropagation|preventDefault)\(\)\s*$/.test(attributeValue(opening, event) ?? ""),
    )
  ) {
    return undefined;
  }
  const inferredLabel = humanizeIdentifier(sourceExpression);
  const usableTextLabel = textLabel && textLabel.length <= 80 ? textLabel : undefined;
  const label =
    explicitLabel ??
    usableTextLabel ??
    associatedTextLabel ??
    callSiteLabel ??
    defaultDynamicLabel ??
    humanizeDynamicLabel(effectiveDynamicLabel) ??
    inferredLabel ??
    `Unlabelled ${kindFor(tag, href, events, target)}`;
  const extractedDestination = destinationFrom(opening, events, sourceExpression);
  const candidateDestinations = attributeDestinationCandidates(opening);
  const destinationValue = candidateDestinations[0] ?? extractedDestination;
  const destination = destinationValue?.includes("pathname") ? routes[0] : destinationValue;
  const kind = /(?:^Tab$|TabTrigger$|TabsTrigger$|SelectItem$|Checkbox$|Switch$)/.test(tag)
    ? "selection"
    : kindFor(tag, href, events, target);
  const closeOwner = node
    .getAncestors()
    .find(
      (ancestor): ancestor is JsxElement =>
        Node.isJsxElement(ancestor) && /(?:Dialog|Drawer|Popover|Sheet)Close$/.test(tagName(ancestor.getOpeningElement())),
    );
  const triggerOwner = node
    .getAncestors()
    .find(
      (ancestor): ancestor is JsxElement =>
        Node.isJsxElement(ancestor) &&
        /(?:Collapsible|Dialog|Drawer|DropdownMenu|Popover|Sheet)Trigger$/.test(tagName(ancestor.getOpeningElement())),
    );
  const formOwner = node.getAncestors().find(
    (ancestor) => Node.isJsxElement(ancestor) && tagName(ancestor.getOpeningElement()) === "form",
  );
  const staticOutcome = /(?:^Tab$|TabTrigger$|TabsTrigger$)/.test(tag)
    ? `${label} tab becomes active`
    : /(?:Dialog|Drawer|DropdownMenu|Popover|Sheet)Trigger$/.test(tag)
      ? `${tag.replace(/Trigger$/, "")} opens`
      : triggerOwner
        ? `${tagName(triggerOwner.getOpeningElement()).replace(/Trigger$/, "")} opens`
        : closeOwner
        ? `${tagName(closeOwner.getOpeningElement()).replace(/Close$/, "")} closes`
        : formOwner && tag === "button" && staticAttributeValue(opening, "type") !== "button"
          ? "Form submission starts"
          : controlledStateOutcome(node, sourceExpression);

  return {
    conditions: conditionsFor(node),
    destination,
    destinationCandidates: candidateDestinations.filter((candidate) => candidate !== destination),
    evidence: { column: position.column, file: relativeFile, line: position.line },
    handler: handlerFrom(sourceExpression),
    id: stableId([relativeFile, String(position.line), String(position.column), kind, label]),
    kind,
    label,
    labelProof: explicitLabel ?? textLabel ?? associatedTextLabel ?? callSiteLabel ?? defaultDynamicLabel ?? isSourceLabelExpression(effectiveDynamicLabel)
      ? "visible"
      : inferredLabel
        ? "semantic"
        : "missing",
    resolved: true,
    routes: [...routes].sort(),
    sourceExpression: conciseExpression(sourceExpression),
    staticOutcome,
  };
}

function mappedCollectionRoot(node: Node): Node | undefined {
  let root: Node | undefined;
  for (const ancestor of node.getAncestors()) {
    if (!Node.isArrowFunction(ancestor) && !Node.isFunctionExpression(ancestor)) continue;
    const call = ancestor.getParentIfKind(SyntaxKind.CallExpression);
    const callee = call?.getExpression();
    if (!callee || !Node.isPropertyAccessExpression(callee) || callee.getName() !== "map") continue;
    root = expressionInitializer(callee.getExpression()) ?? callee.getExpression();
  }
  return root;
}

function interactionsFrom(
  node: JsxElement | JsxSelfClosingElement,
  sourceRoot: string,
  routes: string[],
): JourneyInteraction[] {
  const interaction = interactionFrom(node, sourceRoot, routes);
  if (!interaction?.destination) return interaction ? [interaction] : [];
  const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
  const rawDestination = attributeValue(opening, "href") ?? interaction.destination;
  const destinationAccess = rawDestination.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
  if (!destinationAccess) return [interaction];
  const rawDynamicLabel =
    attributeValue(opening, "aria-label") ??
    attributeValue(opening, "label") ??
    attributeValue(opening, "title") ??
    (Node.isJsxElement(node) ? dynamicText(node) : undefined);
  const dynamicLabel = rawDynamicLabel?.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
  if (!dynamicLabel || dynamicLabel[1] !== destinationAccess[1]) return [interaction];

  const root = mappedCollectionRoot(node);
  if (!root) return [interaction];
  const variants: JourneyInteraction[] = [];
  const objectLiterals = [root, ...root.getDescendants()].filter(Node.isObjectLiteralExpression);
  for (const objectLiteral of objectLiterals) {
    const destinationProperty = objectLiteral.getProperty(destinationAccess[2]);
    const labelProperty = objectLiteral.getProperty(dynamicLabel[2]);
    if (!destinationProperty || !Node.isPropertyAssignment(destinationProperty)) continue;
    if (!labelProperty || !Node.isPropertyAssignment(labelProperty)) continue;
    const destination = staticExpressionValue(destinationProperty.getInitializer());
    const label = staticExpressionValue(labelProperty.getInitializer());
    if (!destination || !label) continue;
    variants.push({
      ...interaction,
      destination,
      destinationCandidates: undefined,
      id: stableId([interaction.id, destination, label]),
      label,
      resolved: true,
    });
  }
  return variants.length > 0 ? variants : [interaction];
}

function extractFrameworkJourneys(config: JourneyConfig, cwd: string, framework: Framework): JourneyManifest {
  const sourceRoot = path.resolve(cwd, config.sourceRoot);
  const tsConfig = path.resolve(cwd, config.tsConfig);
  const project = new Project({ tsConfigFilePath: tsConfig, skipAddingFilesFromTsConfig: false });
  const routeSources =
    framework === "next" ? discoverNextRoutes(project, config, cwd) : discoverViteRoutes(project, config, cwd);
  const duplicatePath = routeSources.find(
    (source, index) => routeSources.findIndex((candidate) => candidate.path === source.path) !== index,
  );
  if (duplicatePath) throw new Error(`${framework} adapter emitted duplicate route ${duplicatePath.path}`);

  const interactionsById = new Map<string, JourneyInteraction>();
  const routes: JourneyRoute[] = [];
  const collectRoute = (entry: SourceFile, routePath: string, area: string, kind: "layout" | "page") => {
    const routeInteractionIds = new Set<string>();
    for (const node of renderedJsx(entry, sourceRoot)) {
      for (const interaction of interactionsFrom(node, sourceRoot, [routePath])) {
        const existing = interactionsById.get(interaction.id);
        if (existing) {
          existing.routes = [...new Set([...existing.routes, routePath])].sort();
        } else {
          interactionsById.set(interaction.id, interaction);
        }
        routeInteractionIds.add(interaction.id);
      }
    }
    routes.push({
      area,
      file: toPosix(path.relative(sourceRoot, entry.getFilePath())),
      interactions: [...routeInteractionIds].sort((leftId, rightId) =>
        compareInteractions(interactionsById.get(leftId)!, interactionsById.get(rightId)!),
      ),
      kind,
      path: routePath,
      redirects: staticRedirects(entry),
      unresolvedRedirects: unresolvedRedirects(entry, sourceRoot),
    });
  };

  for (const source of routeSources) collectRoute(source.file, source.path, source.area, source.kind);

  for (const layoutRoute of routes.filter(
    (route) => route.kind === "layout" && route.path.endsWith(" shared layout"),
  )) {
    const layoutPath = layoutRoute.path.replace(/ shared layout$/, "");
    const childPages = routes.filter(
      (route) => route.kind === "page" && (route.path === layoutPath || route.path.startsWith(`${layoutPath}/`)),
    );
    for (const childPage of childPages) {
      childPage.interactions = [...new Set([...childPage.interactions, ...layoutRoute.interactions])].sort(
        (leftId, rightId) => compareInteractions(interactionsById.get(leftId)!, interactionsById.get(rightId)!),
      );
      childPage.redirects = [...new Set([...childPage.redirects, ...layoutRoute.redirects])].sort();
      childPage.unresolvedRedirects = [
        ...(childPage.unresolvedRedirects ?? []),
        ...(layoutRoute.unresolvedRedirects ?? []),
      ];
    }
    for (const interactionId of layoutRoute.interactions) {
      const interaction = interactionsById.get(interactionId);
      if (!interaction) continue;
      interaction.routes = [
        ...new Set([
          ...interaction.routes.filter((route) => route !== layoutRoute.path),
          ...childPages.map((route) => route.path),
        ]),
      ].sort();
    }
  }
  const screenRoutes = routes.filter((route) => !route.path.endsWith(" shared layout"));

  const interactions = [...interactionsById.values()].sort(compareInteractions);
  return buildJourneyGraph({
    interactions,
    project: config.project,
    routes: screenRoutes.sort((left, right) => left.path.localeCompare(right.path)),
    sourceRoot: toPosix(config.sourceRoot),
  });
}

export function extractJourneys(config: JourneyConfig, cwd = process.cwd()): JourneyManifest {
  return extractFrameworkJourneys(config, cwd, detectFramework(config, cwd));
}

export function extractNextJourneys(config: JourneyConfig, cwd = process.cwd()): JourneyManifest {
  return extractFrameworkJourneys({ ...config, framework: "next" }, cwd, "next");
}
