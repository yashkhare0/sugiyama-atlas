import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildJourneyGraph,
  buildJourneyLayout,
  extractJourneys,
  extractNextJourneys,
  readJourneyConfig,
  renderJourneyHtml,
  zoomToFit,
} from "../src/index.ts";

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-journey-"));
  fs.mkdirSync(path.join(root, "src/app/jobs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/app/jobs/new"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/components"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "preserve", module: "esnext", moduleResolution: "bundler" },
      include: ["src/**/*.ts", "src/**/*.tsx"],
    }),
  );
  fs.writeFileSync(
    path.join(root, "src/components/Actions.tsx"),
    `function Prompt({ label = "Display prompt" }) { return <button onClick={() => setIsOpen(true)}>{label}</button>; } export function Actions() { "plain".replace("p", "P"); return <><button onClick={() => save()}>Save job</button><button onClick={() => cancel()} /><button>Dead end</button><Prompt /></>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/app/layout.tsx"),
    `export default function Layout({ children }) { return <><button aria-label="Open navigation" onClick={() => open()} />{children}</>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `import { Actions } from "../../components/Actions"; export default function Page() { return <main><a href="/jobs/new">New job</a><Actions /></main>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/app/jobs/new/page.tsx"),
    `export default function Page() { return <main>New job</main>; }`,
  );
  return root;
}

test("extracts stable route interactions through local imports", () => {
  const root = fixture();
  const config = { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" };
  const first = extractNextJourneys(config, root);
  const second = extractNextJourneys(config, root);

  assert.deepEqual(first, second);
  assert.equal(first.stats.routes, 3);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.stats.actions, 6);
  assert.equal(first.stats.unresolvedActions, 0);
  assert.ok(first.routes.some((route) => route.path === "/jobs" && route.kind === "page"));
  assert.ok(first.routes.some((route) => route.path === "Global shell" && route.kind === "layout"));
  assert.ok(first.routes.every((route) => route.redirects.length === 0));
  assert.ok(first.interactions.some((interaction) => interaction.label === "Save job"));
  assert.ok(first.interactions.some((interaction) => interaction.label === "Display prompt"));
  assert.ok(!first.interactions.some((interaction) => interaction.label === "label"));
  assert.ok(first.interactions.some((interaction) => interaction.handler === "save()"));
  assert.ok(first.interactions.some((interaction) => interaction.destination === "/jobs/new"));
  const jobsScreen = first.nodes.find((node) => node.id === "screen:/jobs");
  const newJobScreen = first.nodes.find((node) => node.id === "screen:/jobs/new");
  assert.ok(jobsScreen);
  assert.ok(newJobScreen);
  assert.ok(first.edges.some((edge) => edge.kind === "opens" && edge.target === newJobScreen.id));
  assert.ok(first.nodes.some((node) => node.kind === "code-boundary"));
  assert.ok(first.nodes.some((node) => node.kind === "dead-end"));
  assert.ok(first.nodes.some((node) => node.kind === "action" && node.labelProof === "semantic"));
});

test("merges nested layout controls into child screens", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/app/jobs/layout.tsx"),
    `export default function Layout({ children }) { return <><button aria-label="Members" onClick={() => showMembers()} />{children}</>; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  assert.ok(!manifest.routes.some((route) => route.path.includes("shared layout")));
  for (const routePath of ["/jobs", "/jobs/new"]) {
    assert.ok(
      manifest.nodes.some((node) => node.kind === "action" && node.route === routePath && node.label === "Members"),
    );
  }
});

test("does not attribute controls through type-only or non-rendered imports", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/components/HiddenPanel.tsx"),
    `export type HiddenValue = { id: string }; export function HiddenPanel() { return <button onClick={() => eraseEverything()}>Danger</button>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `import type { HiddenValue } from "../../components/HiddenPanel"; const value: HiddenValue = { id: "1" }; export default function Page() { return <main>{value.id}</main>; }`,
  );

  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  assert.ok(!manifest.nodes.some((node) => node.kind === "action" && node.label === "Danger"));
});

test("follows only custom components rendered by the route", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/components/Panels.tsx"),
    `export function VisiblePanel() { return <button onClick={() => save()}>Visible action</button>; } export function HiddenPanel() { return <button onClick={() => remove()}>Hidden action</button>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `import { VisiblePanel, HiddenPanel } from "../../components/Panels"; void HiddenPanel; export default function Page() { return <main><VisiblePanel /></main>; }`,
  );

  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );
  const labels = manifest.nodes.filter((node) => node.kind === "action" && node.route === "/jobs").map((node) => node.label);
  assert.ok(labels.includes("Visible action"));
  assert.ok(!labels.includes("Hidden action"));
});

test("follows components rendered through JSX render props and resolves literal helper arguments", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/components/DataRoute.tsx"),
    `export function DataRoute({ children }) { return children({ connected: true }); }`,
  );
  fs.writeFileSync(
    path.join(root, "src/components/ConnectorPanel.tsx"),
    `import { Link } from "./Link"; function connectorHome(id) { return \`/connectors/\${id}\`; } export function ConnectorPanel() { return <><Link href={connectorHome("slack")}>Manage Slack</Link><Link href={connectorHome("gmail")}>Manage Gmail</Link></>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/components/Link.tsx"),
    `export function Link({ href, children }) { return <a href={href} onClick={() => navigate(href)}>{children}</a>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `import { DataRoute } from "../../components/DataRoute"; import { ConnectorPanel } from "../../components/ConnectorPanel"; export default function Page() { return <DataRoute>{() => <ConnectorPanel />}</DataRoute>; }`,
  );
  fs.mkdirSync(path.join(root, "src/app/connectors/slack"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/app/connectors/gmail"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/app/connectors/slack/page.tsx"), `export default function Page() { return <main>Slack</main>; }`);
  fs.writeFileSync(path.join(root, "src/app/connectors/gmail/page.tsx"), `export default function Page() { return <main>Gmail</main>; }`);

  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  const jobsActions = manifest.nodes.filter((node) => node.kind === "action" && node.route === "/jobs");
  const slack = jobsActions.find((node) => node.label === "Manage Slack");
  const gmail = jobsActions.find((node) => node.label === "Manage Gmail");
  assert.ok(slack);
  assert.ok(gmail);
  assert.ok(!manifest.interactions.some((interaction) => interaction.evidence.file === "components/Link.tsx"));
  assert.ok(manifest.edges.some((edge) => edge.source === slack.id && edge.target === "screen:/connectors/slack"));
  assert.ok(manifest.edges.some((edge) => edge.source === gmail.id && edge.target === "screen:/connectors/gmail"));
});

test("extracts named tab controls and scopes panel controls to their tab", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `export default function Page() { return <Tabs value="details" onValueChange={setTab}><TabsList><Tab value="details">Details</Tab><Tab value="people">People</Tab></TabsList><TabPanels><TabPanel value="details"><Button onClick={() => save()}>Save details</Button></TabPanel><TabPanel value="people"><Button onClick={() => invite()}>Invite person</Button></TabPanel></TabPanels></Tabs>; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );
  const routeActions = manifest.nodes.filter((node) => node.kind === "action" && node.route === "/jobs");
  assert.ok(routeActions.some((node) => node.label === "Details"));
  assert.ok(routeActions.some((node) => node.label === "People"));
  assert.ok(!routeActions.some((node) => node.label === "Value change"));
  assert.deepEqual(routeActions.find((node) => node.label === "Save details")?.conditions, ["Tab is details"]);
  assert.deepEqual(routeActions.find((node) => node.label === "Invite person")?.conditions, ["Tab is people"]);
  assert.ok(manifest.nodes.some((node) => node.kind === "view-state" && node.label === "Details tab becomes active"));
});

test("reports delegated callbacks instead of silently dropping their controls", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/components/Delegated.tsx"),
    `export function Delegated({ onClick }) { return <button onClick={onClick}>Run report</button>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `import { Delegated } from "../../components/Delegated"; export default function Page() { return <Delegated onClick={() => runReport()} />; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );
  assert.ok(manifest.nodes.some((node) => node.kind === "action" && node.label === "Run report"));
  assert.ok(manifest.nodes.some((node) => node.kind === "code-boundary" && node.label === "Runs runReport()"));
});

test("follows a delegated component callback back to its rendered call site", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/components/Delegated.tsx"),
    `export function Delegated({ onContinue }) { return <button onClick={onContinue}>Continue</button>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `import { Delegated } from "../../components/Delegated"; export default function Page() { return <Delegated onContinue={() => router.push("/jobs/new")} />; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );
  const action = manifest.nodes.find((node) => node.kind === "action" && node.route === "/jobs" && node.label === "Continue");
  assert.ok(action);
  assert.equal(manifest.nodes.filter((node) => node.kind === "action" && node.route === "/jobs").length, 1);
  assert.ok(manifest.edges.some((edge) => edge.source === action.id && edge.target === "screen:/jobs/new"));
});

test("resolves a control label passed through a rendered component prop", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/components/Delegated.tsx"),
    `export function Delegated({ label, onContinue }) { return <button aria-label={label} onClick={onContinue} />; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `import { Delegated } from "../../components/Delegated"; export default function Page() { return <Delegated label="Create job" onContinue={() => router.push("/jobs/new")} />; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  assert.ok(manifest.nodes.some((node) => node.kind === "action" && node.label === "Create job"));
  assert.ok(!manifest.diagnostics.some((item) => /label could not be resolved/.test(item.message)));
});

test("proves dialog outcomes from React state ownership", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `export default function Page() { const [isInviteOpen, setIsInviteOpen] = useState(false); return <><button onClick={() => setIsInviteOpen(true)}>Invite</button><Dialog open={isInviteOpen} onOpenChange={setIsInviteOpen}><DialogContent>Invite form</DialogContent></Dialog></>; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  assert.ok(manifest.nodes.some((node) => node.kind === "view-state" && node.label === "Dialog opens"));
  assert.ok(!manifest.diagnostics.some((item) => /open state changes/.test(item.message)));
});

test("proves state outcomes when that state directly controls rendered JSX", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `export default function Page() { const [isEditing, setIsEditing] = useState(false); return <><button onClick={() => setIsEditing(true)}>Edit</button>{isEditing && <section>Edit form</section>}</>; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  assert.ok(manifest.nodes.some((node) => node.kind === "view-state" && node.label === "Editing becomes active"));
  assert.ok(!manifest.diagnostics.some((item) => /local state changes/.test(item.message)));
});

test("follows a local named handler to an exact navigation destination", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `export default function Page() { const openNew = () => router.push("/jobs/new"); return <button onClick={openNew}>Continue</button>; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );
  const action = manifest.nodes.find((node) => node.kind === "action" && node.route === "/jobs" && node.label === "Continue");
  assert.ok(action);
  assert.ok(manifest.edges.some((edge) => edge.source === action.id && edge.target === "screen:/jobs/new"));
});

test("renders searchable standalone HTML with source evidence", () => {
  const root = fixture();
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );
  const html = renderJourneyHtml(manifest, "window.cytoscape = () => ({});", "window.ELK = class {};");

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Sugiyama · #Fixture<\/title>/);
  assert.match(html, /<strong>Sugiyama<\/strong><span>#Fixture<\/span>/);
  assert.doesNotMatch(html, />Fixture product journeys</);
  assert.match(html, /Save job/);
  assert.match(html, /components\/Actions\.tsx/);
  assert.match(html, /"line":1/);
  assert.match(html, /journey-graph/);
  assert.match(html, /window\.cytoscape/);
  assert.match(html, /window\.ELK/);
  assert.match(html, /LAYER_SWEEP/);
  assert.match(html, /Explore this screen/);
  assert.match(html, /User journey/);
  assert.match(html, />Atlas</);
  assert.match(html, /journey-mode/);
  assert.match(html, /journey-global-navigation/);
  assert.match(html, /Available throughout the app/);
  assert.match(html, /sharedThreshold/);
  assert.match(html, /details-open/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /ArrowLeft/);
  assert.match(html, /"source-endpoint":"50% 0%"/);
  assert.match(html, /"target-endpoint":"-50% 0%"/);
  assert.match(html, /<span>Jobs<\/span>/);
  assert.doesNotMatch(html, /<span>\/jobs<\/span>/);
  assert.match(html, /Every screen is expanded/);
  assert.match(html, /screen → interface group → control → proven result/);
  assert.match(html, /atlas-group:/);
  assert.match(html, /atlas-action:/);
  assert.match(html, /Tab navigation/);
  assert.match(html, /Dialog is open/);
  assert.doesNotMatch(html, /node\[kind='(?:atlas-area|ui-group)'\][^}]*text-margin-x/);
  assert.match(html, /revision!==graphRevision\|\|view\.type!=="journey"/);
  assert.match(html, /Warm-white systems canvas/);
  assert.match(html, /Returns to/);
  assert.match(html, /color-scheme:light/);
  assert.match(html, /minimap-image/);
  assert.match(html, /minimap-viewport/);
  assert.match(html, /maxWidth:440/);
  assert.match(html, /taxi-direction":"downward/);
  assert.match(html, /screenRole='detail'/);
  assert.match(html, /without detected incoming navigation/);
  assert.match(html, /NOT REACHED FROM ANOTHER SCREEN/);
  assert.match(html, /Redirects in source/);
  assert.doesNotMatch(html, /No proven entry path/);
  assert.match(html, /unresolved/);
});

test("derives the project name from the repository folder", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "sugiyama-project-"));
  fs.mkdirSync(path.join(repository, ".git"));
  const frontend = path.join(repository, "apps/frontend");
  fs.mkdirSync(frontend, { recursive: true });
  fs.writeFileSync(
    path.join(frontend, "journeys.config.json"),
    JSON.stringify({ output: "journeys.html", sourceRoot: "src", tsConfig: "tsconfig.json" }),
  );

  const config = readJourneyConfig("journeys.config.json", frontend);

  assert.equal(config.project, path.basename(repository));
});

test("extracts statically declared Vite React Router routes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sugiyama-vite-"));
  fs.mkdirSync(path.join(root, "src/pages"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { vite: "7.3.5" } }));
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { jsx: "preserve", module: "esnext", moduleResolution: "bundler" },
      include: ["src/**/*.ts", "src/**/*.tsx"],
    }),
  );
  fs.writeFileSync(
    path.join(root, "src/pages/Home.tsx"),
    `export function Home() { return <a href="/jobs/42">Open job</a>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/pages/Job.tsx"),
    `export function Job() { return <button onClick={() => saveJob()}>Save job</button>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/pages/Settings.tsx"),
    `export function Settings() { return <button onClick={() => saveSettings()}>Save settings</button>; }`,
  );
  fs.writeFileSync(
    path.join(root, "src/App.tsx"),
    `import { Home } from "./pages/Home"; import { Job } from "./pages/Job"; import { Settings } from "./pages/Settings"; export function App() { return <Routes><Route path="/" element={<Home />} /><Route path="/jobs/:jobId" element={<Job />} /><Route path="/workspace"><Route path="settings" element={<Settings />} /></Route></Routes>; }`,
  );

  const manifest = extractJourneys(
    { output: "journeys.html", project: "Vite fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  assert.deepEqual(
    manifest.routes.map((route) => route.path),
    ["/", "/jobs/[jobId]", "/workspace/settings"],
  );
  assert.ok(
    manifest.interactions.some((interaction) => interaction.label === "Open job"),
    JSON.stringify({ interactions: manifest.interactions, routes: manifest.routes }),
  );
  assert.ok(manifest.interactions.some((interaction) => interaction.label === "Save job"));
  assert.ok(manifest.interactions.some((interaction) => interaction.label === "Save settings"));
  assert.equal(manifest.diagnostics.length, 0);
});

test("fails early when a Vite project has no statically provable routes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sugiyama-vite-empty-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { vite: "7.3.5" } }));
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { jsx: "preserve" }, include: ["src/**/*.tsx"] }),
  );
  fs.writeFileSync(path.join(root, "src/App.tsx"), `export function App() { return <main>No router</main>; }`);

  assert.throws(
    () =>
      extractJourneys(
        { output: "journeys.html", project: "Vite fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
        root,
      ),
    /Vite adapter found no statically declared React Router routes/,
  );
});

test("connects data-driven destinations to canonical screens", () => {
  const manifest = buildJourneyGraph({
    interactions: [
      {
        conditions: [],
        destination: "tab.href",
        destinationCandidates: ['"/reports"', "`/jobs/${job.id}`"],
        evidence: { column: 1, file: "Tabs.tsx", line: 10 },
        id: "tabs",
        kind: "link",
        label: "Tab",
        resolved: true,
        routes: ["/"],
      },
    ],
    project: "Fixture",
    routes: [
      { area: "Home", file: "app/page.tsx", interactions: ["tabs"], kind: "page", path: "/", redirects: [] },
      {
        area: "Jobs",
        file: "app/jobs/[id]/page.tsx",
        interactions: [],
        kind: "page",
        path: "/jobs/[id]",
        redirects: [],
      },
      {
        area: "Reports",
        file: "app/reports/page.tsx",
        interactions: [],
        kind: "page",
        path: "/reports",
        redirects: [],
      },
    ],
    sourceRoot: "src",
  });

  const destinations = manifest.edges
    .filter((edge) => edge.kind === "opens")
    .map((edge) => edge.target)
    .sort();
  assert.deepEqual(destinations, ["screen:/jobs/[id]", "screen:/reports"]);
  assert.equal(manifest.diagnostics.length, 0);
});

test("classifies a source-proven new-tab destination without guessing its runtime URL", () => {
  const manifest = buildJourneyGraph({
    interactions: [
      {
        conditions: [],
        destination: "candidate.linkedinUrl",
        evidence: { column: 1, file: "Candidate.tsx", line: 4 },
        id: "linkedin",
        kind: "external-link",
        label: "LinkedIn",
        resolved: true,
        routes: ["/candidates"],
      },
    ],
    project: "Fixture",
    routes: [
      { area: "Candidates", file: "app/candidates/page.tsx", interactions: ["linkedin"], kind: "page", path: "/candidates", redirects: [] },
    ],
    sourceRoot: "src",
  });

  assert.ok(manifest.nodes.some((node) => node.kind === "external-exit" && /LinkedIn/.test(node.label)));
  assert.equal(manifest.stats.unresolvedSourceControls, 0);
});

test("resolves imported route constants without guessing by route name", () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, "src/lib"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src/lib/routes.ts"),
    `export const ROUTES = { jobs: { path: "/jobs" }, reports: { path: "/reports" } } as const;`,
  );
  fs.mkdirSync(path.join(root, "src/app/reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/app/reports/page.tsx"), `export default function Page() { return <main />; }`);
  fs.writeFileSync(
    path.join(root, "src/app/page.tsx"),
    `import { ROUTES } from "../lib/routes"; export default function Page() { return <a href={ROUTES.reports.path}>Reports</a>; }`,
  );

  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );
  const action = manifest.nodes.find((node) => node.kind === "action" && node.route === "/" && node.label === "Reports");
  assert.ok(action);
  assert.equal(manifest.interactions.find((interaction) => interaction.label === "Reports")?.destination, "/reports");
  assert.ok(
    manifest.edges.some((edge) => edge.kind === "opens" && edge.source === action.id && edge.target === "screen:/reports"),
  );
  assert.ok(!manifest.edges.some((edge) => edge.source === action.id && edge.target === "screen:/jobs"));
});

test("expands a mapped navigation collection into separately named controls", () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, "src/app/reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/app/reports/page.tsx"), `export default function Page() { return <main />; }`);
  fs.writeFileSync(
    path.join(root, "src/app/layout.tsx"),
    `const items = [{ title: "Jobs", url: "/jobs" }, { title: "Reports", url: "/reports" }] as const;
     export default function Layout({ children }) { return <>{items.map((item) => <a key={item.url} href={item.url}>{item.title}</a>)}{children}</>; }`,
  );

  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );
  const shellActions = manifest.nodes.filter((node) => node.kind === "action" && node.route === "Global shell");
  assert.deepEqual(
    shellActions.map((node) => node.label).sort(),
    ["Jobs", "Reports"],
  );
  for (const [label, route] of [
    ["Jobs", "/jobs"],
    ["Reports", "/reports"],
  ]) {
    const action = shellActions.find((node) => node.label === label);
    assert.ok(action);
    assert.ok(manifest.edges.some((edge) => edge.source === action.id && edge.target === `screen:${route}`));
  }
});

test("does not turn an unknown handler into a claimed successful outcome", () => {
  const manifest = buildJourneyGraph({
    interactions: [
      {
        conditions: [],
        evidence: { column: 1, file: "Unknown.tsx", line: 1 },
        handler: "performOpaqueOperation()",
        id: "unknown",
        kind: "button",
        label: "Proceed",
        resolved: true,
        routes: ["/"],
      },
    ],
    project: "Fixture",
    routes: [{ area: "Home", file: "app/page.tsx", interactions: ["unknown"], kind: "page", path: "/", redirects: [] }],
    sourceRoot: "src",
  });

  assert.equal(manifest.stats.unresolvedActions, 0);
  assert.ok(manifest.nodes.some((node) => node.kind === "code-boundary" && node.label === "Runs performOpaqueOperation()"));
  assert.ok(!manifest.nodes.some((node) => node.kind === "completed-outcome" && /succeeds/i.test(node.label)));
});

test("does not classify event-driven router navigation as an automatic redirect", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `export default function Page() { const router = useRouter(); return <button onClick={() => router.push("/jobs/new")}>Continue</button>; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  assert.deepEqual(manifest.routes.find((route) => route.path === "/jobs")?.redirects, []);
  assert.ok(manifest.edges.some((edge) => edge.kind === "opens" && edge.target === "screen:/jobs/new"));
});

test("does not mistake ordinary string replacement for router navigation", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/app/jobs/page.tsx"),
    `export default function Page() { return <button onClick={() => slug.replace(/[^a-z0-9]+/g, "-")}>Normalize</button>; }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  assert.ok(!manifest.diagnostics.some((item) => item.message.includes("No canonical screen matches")));
});

test("captures only statically proven framework redirects as system transitions", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/app/page.tsx"),
    `export default function Page() { redirect("/jobs"); }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );
  assert.deepEqual(manifest.routes.find((route) => route.path === "/")?.redirects, ["/jobs"]);
  assert.ok(
    manifest.edges.some(
      (edge) => edge.kind === "redirects" && edge.source === "screen:/" && edge.target === "screen:/jobs",
    ),
  );
});

test("fails visibly when a framework redirect destination is dynamic", () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, "src/app/page.tsx"),
    `export default function Page() { const destination = resolveDestination(); redirect(destination); }`,
  );
  const manifest = extractNextJourneys(
    { output: "journeys.html", project: "Fixture", sourceRoot: "src", tsConfig: "tsconfig.json" },
    root,
  );

  assert.equal(manifest.stats.unresolvedSystemTransitions, 1);
  assert.equal(manifest.stats.unresolvedSourceControls, 0);
  assert.ok(manifest.diagnostics.some((item) => /Redirect destination could not be resolved/.test(item.message)));
});

test("describes local outcomes in user-observable language", () => {
  const manifest = buildJourneyGraph({
    interactions: [
      {
        conditions: [],
        evidence: { column: 1, file: "CandidateRow.tsx", line: 10 },
        handler: 'onLabel("pending", candidate)',
        id: "pending",
        kind: "button",
        label: "Pending",
        resolved: true,
        routes: ["/candidates"],
      },
      {
        conditions: [],
        evidence: { column: 1, file: "CandidateRow.tsx", line: 11 },
        handler: "refetch()",
        id: "retry",
        kind: "button",
        label: "Try again",
        resolved: true,
        routes: ["/candidates"],
      },
    ],
    project: "Fixture",
    routes: [
      {
        area: "Candidates",
        file: "app/candidates/page.tsx",
        interactions: ["pending", "retry"],
        kind: "page",
        path: "/candidates",
        redirects: [],
      },
    ],
    sourceRoot: "src",
  });

  const outcomes = manifest.nodes.filter((node) => node.kind === "completed-outcome" || node.kind === "view-state");
  assert.ok(outcomes.some((node) => node.label === "Status is set to Pending"));
  assert.ok(outcomes.some((node) => node.label === "Data reload requested" && node.proof === "source"));
  assert.ok(outcomes.every((node) => !/completed|mutate|refetch/i.test(node.label)));
});

test("replaces implementation-shaped action labels with interaction meaning", () => {
  const base = {
    conditions: [],
    evidence: { column: 1, file: "Example.tsx", line: 10 },
    kind: "button" as const,
    resolved: true,
    routes: ["/example"],
  };
  const manifest = buildJourneyGraph({
    interactions: [
      { ...base, handler: "openDialog", id: "dialog", label: "secondary" },
      { ...base, handler: "setIsOpen", id: "collapsible", label: "isOpen" },
      { ...base, handler: "() => onSelect(version)", id: "version", label: "IconCheck" },
    ],
    project: "Fixture",
    routes: [
      {
        area: "Example",
        file: "app/example/page.tsx",
        interactions: ["dialog", "collapsible", "version"],
        kind: "page",
        path: "/example",
        redirects: [],
      },
    ],
    sourceRoot: "src",
  });

  const labels = manifest.nodes.filter((node) => node.kind === "action").map((node) => node.label);
  assert.deepEqual(labels.sort(), ["Expand or collapse section", "Open dialog", "Select version"]);
});

test("the complete expanded graph fits supported overview viewports", () => {
  const routes = Array.from({ length: 40 }, (_, routeIndex) => ({
    area: `Area ${routeIndex % 8}`,
    file: `app/route-${routeIndex}/page.tsx`,
    interactions: Array.from({ length: 30 }, (_, actionIndex) => `action-${routeIndex}-${actionIndex}`),
    kind: "page" as const,
    path: `/route-${routeIndex}`,
    redirects: [],
  }));
  const interactions = routes.flatMap((route) =>
    route.interactions.map((interactionId, actionIndex) => ({
      conditions: [],
      evidence: { column: 1, file: route.file, line: actionIndex + 1 },
      handler: `saveItem${actionIndex}()`,
      id: interactionId,
      kind: "button" as const,
      label: `Save item ${actionIndex}`,
      resolved: true,
      routes: [route.path],
    })),
  );
  const manifest = buildJourneyGraph({ interactions, project: "Large fixture", routes, sourceRoot: "src" });
  const layout = buildJourneyLayout(manifest);

  assert.ok(manifest.nodes.length > 2_000);
  assert.ok(zoomToFit(layout, { width: 1180, height: 760 }) >= 0.005);
  assert.ok(zoomToFit(layout, { width: 390, height: 760 }) >= 0.005);
  assert.equal(Object.keys(layout.positions).length, manifest.nodes.length);
});
