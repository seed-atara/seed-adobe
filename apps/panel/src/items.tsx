import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

/**
 * The standalone item authoring tool.
 *
 * The same bundle as the panel, with the generation tabs left out: a producer
 * or concept artist opens this in a browser, builds the cast, and exports
 * packs — no After Effects, no CEP, no Adobe at all. Because it is the same
 * component, the tab inside the host and the tool outside it cannot drift.
 */
const root = document.getElementById("root");
if (!root) throw new Error("items root element is missing");

createRoot(root).render(
  <StrictMode>
    <App tabs={["items", "library"]} />
  </StrictMode>,
);
