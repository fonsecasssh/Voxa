import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "@fontsource-variable/inter";
import "@fontsource-variable/sora";
import "./styles.css";
import { appSettings, applyTheme } from "./appSettings.ts";

// Before the first render, so the app never flashes in the default colors.
applyTheme(appSettings.get().theme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
