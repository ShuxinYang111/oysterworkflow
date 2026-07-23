import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CloudAuthBoundary } from "./cloud-auth";
import { initializeRendererErrorMonitoring } from "./sentry";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import "./cloud-auth.css";

initializeRendererErrorMonitoring();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CloudAuthBoundary>
      <App />
    </CloudAuthBoundary>
  </React.StrictMode>,
);
