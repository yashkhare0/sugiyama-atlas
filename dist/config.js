import fs from "node:fs";
import path from "node:path";
function findProjectDirectory(start) {
    let directory = start;
    while (true) {
        if (fs.existsSync(path.join(directory, ".git")))
            return directory;
        const parent = path.dirname(directory);
        if (parent === directory)
            return start;
        directory = parent;
    }
}
export function defaultJourneyConfig(cwd = process.cwd()) {
    const projectDirectory = findProjectDirectory(cwd);
    const project = path.basename(projectDirectory);
    return {
        output: path.join("artifacts", `${project}-user-journeys.html`),
        project,
        sourceRoot: "src",
        tsConfig: "tsconfig.json",
    };
}
export function readJourneyConfig(configPath, cwd = process.cwd()) {
    const absolutePath = path.resolve(cwd, configPath);
    const value = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    if (!value || typeof value !== "object")
        throw new Error("Journey config must be a JSON object");
    const config = value;
    for (const key of ["output", "sourceRoot", "tsConfig"]) {
        if (typeof config[key] !== "string" || !config[key])
            throw new Error(`Journey config requires a non-empty ${key}`);
    }
    const projectDirectory = findProjectDirectory(path.dirname(absolutePath));
    return { ...config, project: path.basename(projectDirectory) };
}
//# sourceMappingURL=config.js.map