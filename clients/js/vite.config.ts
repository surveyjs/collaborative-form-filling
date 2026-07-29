import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Mounted at /js/ by the app server. survey-core / survey-js-ui come from the
// sibling survey-library fork's build output via file: dependencies.
export default defineConfig({
  base: "/js/",
  resolve: {
    dedupe: ["survey-core", "survey-js-ui"],
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
  },
});
