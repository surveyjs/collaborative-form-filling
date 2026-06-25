import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Read the `type` from the URL, falling back to a value persisted earlier in
// this tab so the embedding type survives a full reload on a "clean" URL
// (e.g. when an embedding parent reloads the iframe without the param).
const type =
  new URLSearchParams(window.location.search).get("type") ??
  sessionStorage.getItem("type");
if (type) {
  sessionStorage.setItem("type", type);
  document.body.classList.add(`type_${type}`);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
