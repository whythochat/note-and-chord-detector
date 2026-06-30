// Theme handling. Loaded in <head> so the saved theme is applied before the
// page paints (avoids a flash of the wrong theme). The toggle button itself is
// wired up later in app.js, once the DOM exists.

/**
 * Read the persisted theme, falling back to the OS preference, then dark.
 *
 * @returns {"light"|"dark"} The theme to use.
 */
function storedTheme() {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch (e) { /* storage blocked */ }
  if (saved === "light" || saved === "dark") return saved;
  const prefersLight = window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}

/**
 * Apply a theme to the document and persist the choice.
 *
 * @param {"light"|"dark"} theme - The theme to activate.
 * @returns {void}
 */
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("theme", theme); } catch (e) { /* storage blocked */ }
}

/**
 * The theme currently applied to the document.
 *
 * @returns {"light"|"dark"} The active theme.
 */
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

// Apply immediately, before the body renders.
document.documentElement.setAttribute("data-theme", storedTheme());
