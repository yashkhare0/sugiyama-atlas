# Sugiyama

Sugiyama compiles React source code into a deterministic, interactive product-journey graph. It maps canonical screens, visible controls, proven navigation, local UI outcomes, external exits, and unresolved paths without crawling the running application.

The generated viewer is a standalone HTML file with two views:

- **User journey** groups global navigation once and shows contextual screen-to-screen transitions as a readable left-to-right flow.
- **Atlas** expands every screen into interface groups, controls, and source-proven results.

Every node retains its source file and position. Unsupported or unresolved behavior is reported explicitly; Sugiyama does not invent successful outcomes.

## Requirements

- Node.js 20 or newer
- A React frontend using TypeScript
- Next.js App Router or Vite with statically declared React Router routes
- A `tsconfig.json` that includes the frontend source
- SSH access to the private GitHub repository

## Install and run

From the root of the frontend project:

```sh
pnpm add -D git+ssh://git@github.com/yashkhare0/sugiyama-atlas.git#v0.1.0
pnpm exec sugiyama
```

Then open:

```text
artifacts/<project-folder>-user-journeys.html
```

Sugiyama derives the displayed project name from the Git repository folder. A zero-config run expects `src/` and `tsconfig.json` in the current directory.

To make generation repeatable for the team, add a package script:

```json
{
  "scripts": {
    "journeys": "sugiyama"
  }
}
```

Then run:

```sh
pnpm journeys
```

## Generated artifacts

Each run writes three files:

```text
artifacts/<project>-user-journeys.html
artifacts/<project>-user-journeys.json
artifacts/<project>-user-journeys.diagnostics.json
```

- The HTML file is the offline interactive viewer.
- The JSON file is the complete versioned graph manifest.
- The diagnostics file contains every unresolved compiler finding.

If analysis is incomplete, Sugiyama still writes the partial artifacts for debugging and exits non-zero. Do not treat that output as an authoritative complete map.

## Configuration

Zero configuration is preferred. When paths differ, create `sugiyama.config.json` in the frontend root:

```json
{
  "sourceRoot": "src",
  "tsConfig": "tsconfig.json",
  "output": "artifacts/product-journeys.html",
  "framework": "vite",
  "areaLabels": {
    "settings": "Administration"
  }
}
```

Available fields:

- `sourceRoot`: frontend source directory
- `appDirectory`: optional Next.js App Router directory
- `tsConfig`: TypeScript project used to resolve imports
- `output`: HTML output path; sibling JSON files are written automatically
- `framework`: optional `next` or `vite`; normally auto-detected
- `areaLabels`: optional display labels for first-level route groups

You can also supply a specific configuration file:

```sh
pnpm exec sugiyama path/to/config.json
```

## Supported routing

### Next.js

Sugiyama reads App Router `page.tsx` and `layout.tsx` files and merges shared layout controls into their child routes.

### Vite and React Router

Routes must be statically declared:

```tsx
<Route path="/jobs/:jobId" element={<Job />} />
```

```tsx
{ path: "/jobs/:jobId", element: <Job /> }
{ path: "/jobs/:jobId", Component: Job }
```

Nested literal paths are supported, and `:jobId` is normalized to `[jobId]`. Runtime-generated route tables and unsupported routers fail with an actionable error.

## What the compiler proves

- Rendered local component trees and JSX render props
- Links, buttons, forms, fields, dialogs, tabs, selections, and meaningful state changes
- Imported route constants and literal route-helper calls
- Statically declared mapped navigation collections
- Exact internal destinations, framework redirects, external exits, and runtime-dependent destinations
- Source conditions such as active tabs, open dialogs, and conditional rendering

Callback boundaries, controls without application handlers, missing visible labels, and runtime-dependent destinations remain visible audit findings. They are not presented as completed product behavior.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:local
pnpm package:smoke artifacts/sugiyama-atlas-0.1.0.tgz
```

The smoke test installs the packed package into clean Next.js and Vite fixtures and confirms both generate authoritative artifacts.

## Current scope

Sugiyama performs static source analysis only. Authenticated runtime crawling and generated routing are intentionally outside the current scope.
