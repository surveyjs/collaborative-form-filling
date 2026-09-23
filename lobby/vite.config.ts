import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The lobby is served from "/" by the app server (Vite middleware in dev,
// static dist in prod). This config is only used by `vite build`, which bundles
// the npm survey packages; the dev server resolves them from the sibling
// survey-library checkout instead (server/src/localSurvey.ts). dedupe keeps a
// single survey-core instance so its Serializer singleton isn't duplicated.
export default defineConfig({
  base: "/",
  plugins: [react()],
  resolve: {
    // react/react-dom deliberately not deduped: survey-react-ui runs on its
    // own React 17 copy in the local build; forcing one React 18 instance
    // there breaks dropdown popups.
    dedupe: ["survey-core", "survey-react-ui"],
  },
});
