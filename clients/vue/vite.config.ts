import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Mounted at /vue/ by the app server. survey-core / survey-vue3-ui come from
// the sibling survey-library fork's build output via file: dependencies.
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
