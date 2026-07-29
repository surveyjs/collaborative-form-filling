/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React client is mounted at /react/ by the app server (Vite middleware
// in dev, static dist in prod). survey-core / survey-react-ui come from the
// sibling survey-library fork's build output via file: dependencies — dedupe
// keeps a single survey-core instance (its Serializer is a singleton).
export default defineConfig({
  base: "/react/",
  plugins: [react()],
  resolve: {
    // react/react-dom deliberately not deduped: survey-react-ui runs on its
    // own React 17 copy; forcing one React 18 instance breaks dropdown popups.
    dedupe: ["survey-core", "survey-react-ui"],
  },
  server: {
    // The file:-linked fork builds live outside the package root; without
    // this the dev server returns 403 for their real paths (incl. CSS).
    fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          survey: ["survey-core", "survey-react-ui"],
          socket: ["socket.io-client"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
