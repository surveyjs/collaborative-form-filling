import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Mounted at /js/ by the app server. `vite build` bundles the npm survey
// packages; the dev server resolves them from the sibling survey-library
// checkout (server/src/localSurvey.ts).
export default defineConfig({
  base: "/js/",
  resolve: {
    dedupe: ["survey-core", "survey-js-ui"],
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
  },
});
