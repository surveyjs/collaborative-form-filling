import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// package.json pins the published survey packages, so `vite build` and a plain
// `npm install` never need the survey-library checkout. In serve mode (the dev
// middlewares, vitest) this plugin redirects the same imports to the sibling
// checkout's build output, so plugin work there shows up here without a publish.
// SURVEY_LIBRARY overrides the checkout path; SURVEY_LIBRARY=npm keeps npm.

const SURVEY_IMPORT = /^(survey-core|survey-react-ui|survey-js-ui|survey-vue3-ui)(\/.*)?$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let announced = false;
function announce(message: string): void {
  if (announced) return;
  announced = true;
  console.log(`[survey] ${message}`);
}

export function localSurvey(): Plugin | null {
  const setting = process.env.SURVEY_LIBRARY;
  if (setting === "npm") {
    announce("SURVEY_LIBRARY=npm — using npm packages");
    return null;
  }
  const libRoot = path.resolve(setting || path.join(repoRoot, "..", "survey-library"));
  const buildOf = (name: string) => path.join(libRoot, "packages", name, "build");
  const corePackage = path.join(buildOf("survey-core"), "package.json");
  if (!existsSync(corePackage)) {
    announce(`local build not found in ${libRoot} — using npm packages`);
    return null;
  }
  announce(`local survey-library ${JSON.parse(readFileSync(corePackage, "utf8")).version} (${libRoot})`);

  const exportsOf = new Map<string, Record<string, any>>();
  return {
    name: "local-survey-library",
    enforce: "pre",
    resolveId(source) {
      const match = SURVEY_IMPORT.exec(source);
      if (!match) return null;
      const [, name, subpath = ""] = match;
      const build = buildOf(name);
      if (!exportsOf.has(name)) {
        exportsOf.set(name, JSON.parse(readFileSync(path.join(build, "package.json"), "utf8")).exports ?? {});
      }
      // Pattern entries ("./*.css": "./*.css") map a subpath onto itself, so a
      // missing exact entry falls back to the file of the same name.
      const entry = exportsOf.get(name)![`.${subpath}`];
      const target = typeof entry === "string" ? entry : entry?.import;
      return path.join(build, target ?? `.${subpath}`);
    },
  };
}
