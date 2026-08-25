import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tarballArgument = process.argv[2];
if (!tarballArgument) throw new Error("Usage: node scripts/package-smoke.mjs <sugiyama.tgz>");
const tarball = path.resolve(tarballArgument);
if (!fs.existsSync(tarball)) throw new Error(`Tarball does not exist: ${tarball}`);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sugiyama-package-smoke-"));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function command(cwd, executable, arguments_) {
  const result = spawnSync(executable, arguments_, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${executable} ${arguments_.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function prepareProject(name) {
  const root = path.join(temporaryRoot, name);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  write(path.join(root, "package.json"), `${JSON.stringify({ name, private: true }, null, 2)}\n`);
  write(
    path.join(root, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: { jsx: "preserve", module: "esnext", moduleResolution: "bundler" },
        include: ["src/**/*.ts", "src/**/*.tsx"],
      },
      null,
      2,
    )}\n`,
  );
  command(root, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball]);
  return root;
}

function assertOutput(root, project) {
  const output = path.join(root, "artifacts", `${project}-user-journeys.json`);
  assert.ok(fs.existsSync(output), `missing generated manifest ${output}`);
  const manifest = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(manifest.project, project);
  assert.equal(manifest.diagnostics.length, 0);
  assert.ok(manifest.routes.length > 0);
  assert.ok(manifest.interactions.length > 0);
}

try {
  const nextRoot = prepareProject("next-project");
  write(
    path.join(nextRoot, "src/app/page.tsx"),
    `export default function Page() { return <a href="/jobs">Open jobs</a>; }`,
  );
  write(
    path.join(nextRoot, "src/app/jobs/page.tsx"),
    `export default function Page() { return <button onClick={() => save()}>Save</button>; }`,
  );
  command(nextRoot, path.join(nextRoot, "node_modules/.bin/sugiyama"), []);
  assertOutput(nextRoot, "next-project");

  const viteRoot = prepareProject("vite-project");
  const packageJson = JSON.parse(fs.readFileSync(path.join(viteRoot, "package.json"), "utf8"));
  packageJson.devDependencies = { vite: "7.3.5" };
  write(path.join(viteRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  write(path.join(viteRoot, "src/pages/Home.tsx"), `export function Home() { return <a href="/jobs/42">Open job</a>; }`);
  write(path.join(viteRoot, "src/pages/Job.tsx"), `export function Job() { return <button onClick={() => save()}>Save</button>; }`);
  write(
    path.join(viteRoot, "src/App.tsx"),
    `import { Home } from "./pages/Home"; import { Job } from "./pages/Job"; export function App() { return <Routes><Route path="/" element={<Home />} /><Route path="/jobs/:jobId" element={<Job />} /></Routes>; }`,
  );
  command(viteRoot, path.join(viteRoot, "node_modules/.bin/sugiyama"), []);
  assertOutput(viteRoot, "vite-project");

  console.log("Installed tarball generated authoritative Next.js and Vite artifacts.");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
