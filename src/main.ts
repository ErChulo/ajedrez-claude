import "./style.css";
import { mountApp } from "./ui/App";
import { applyStoredTheme, getStoredTheme } from "./themes/persistence";

// Apply theme before any pixels paint so there's no flash of fallback palette.
applyStoredTheme();

const root = document.getElementById("app");
if (!root) throw new Error("#app root not found");
mountApp(root, { initialTheme: getStoredTheme() });
