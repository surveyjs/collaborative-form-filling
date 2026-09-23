import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Mounted at /vue/ by the app server. `vite build` bundles the npm survey
// packages; the dev server resolves them from the sibling survey-library
// checkout (server/src/localSurvey.ts).
export default defineConfig({
  base: "/vue/",
  plugins: [vue()],
  resolve: {
    dedupe: ["survey-core", "survey-vue3-ui", "vue"],
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
  },
});
