/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  // In dev (`vite serve`) resolve survey-core / survey-react-ui to the local
  // build output of the sibling survey-library checkout, so library changes are
  // picked up without publishing. Production builds (`vite build`) and tests
  // keep using the registry version pinned in package.json. Opt out for a single
  // dev run with SURVEY_LOCAL=0.
  const useLocalSurvey =
    command === "serve" && mode !== "test" && process.env.SURVEY_LOCAL !== "0";

  // <repo>/packages/client -> <repo> -> Survey/ (holds both checkouts). We point
  // at build/ (not the package root) because that is what gets published.
  const surveyLibBase = "../../../survey-library/packages";
  const localCore = fileURLToPath(
    new URL(`${surveyLibBase}/survey-core/build`, import.meta.url),
  );
  const localReact = fileURLToPath(
    new URL(`${surveyLibBase}/survey-react-ui/build`, import.meta.url),
  );

  return {
    plugins: [react()],
    resolve: {
      // The bare `survey-core` import inside the local survey-react-ui build is
      // caught by the same alias, keeping a single survey-core instance.
      alias: useLocalSurvey
        ? { "survey-core": localCore, "survey-react-ui": localReact }
        : {},
    },
    // The local build/ dirs live outside the workspace root; without this the dev
    // server returns 403 for them (incl. survey-core.min.css). The client is
    // otherwise served by the Express server (Vite runs in middleware mode), so
    // no standalone dev server / proxy config is needed here.
    server: useLocalSurvey
      ? { fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } }
      : undefined,
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
  };
});
