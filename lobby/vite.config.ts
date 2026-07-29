import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The lobby is served from "/" by the app server (Vite middleware in dev,
// static dist in prod). survey-core/survey-react-ui arrive as file: junctions
// into the sibling survey-library fork's build output — dedupe keeps a single
// survey-core instance so its Serializer singleton isn't duplicated.
export default defineConfig({
  base: "/",
  plugins: [react()],
  resolve: {
    // react/react-dom deliberately not deduped: survey-react-ui runs on its
    // own React 17 copy; forcing one React 18 instance breaks dropdown popups.
    dedupe: ["survey-core", "survey-react-ui"],
  },
});
