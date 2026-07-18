import React from "react";
import { createRoot } from "react-dom/client";
import BandoAdmin from "./BandoAdmin.jsx";
import "./styles/global.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BandoAdmin />
  </React.StrictMode>,
);
