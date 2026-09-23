/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localSurvey } from "../../server/src/localSurvey";

// The React client is mounted at /react/ by the app server (Vite middleware
// in dev, static dist in prod). `vite build` bundles the npm survey packages;
// serve mode (vitest here) resolves them from the sibling survey-library
// checkout, as the dev server does. dedupe keeps a single survey-core
// instance (its Serializer is a singleton).
export default defineConfig(({ command }) => ({
  base: "/react/",
  plugins: [command === "serve" && localSurvey(), react()],
  resolve: {
    // react/react-dom deliberately not deduped: survey-react-ui runs on its
    // own React 17 copy in the local build; forcing one React 18 instance
    // there breaks dropdown popups.
    dedupe: ["survey-core", "survey-react-ui"],
  },
  server: {
    // The local survey-library build lives outside the package root; without
    // this the dev server returns 403 for its real paths (incl. CSS).
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          survey: ["survey-core", "survey-react-ui"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
}));
