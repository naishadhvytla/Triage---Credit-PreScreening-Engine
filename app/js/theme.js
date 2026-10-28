/* Theme: system → light → dark. Loaded in <head> so the saved theme applies before first paint. */
(function () {
  var KEY = "triage-theme", root = document.documentElement;
  var NEXT = {system: "light", light: "dark", dark: "system"};
  var LABEL = {system: "Theme: match system", light: "Theme: light", dark: "Theme: dark"};
  var ICON = {
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>'
  };
  function get() { try { return localStorage.getItem(KEY) || "system"; } catch (e) { return "system"; } }
  function apply(t) { if (t === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t); }
  function paint() {
    var t = get();
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.innerHTML = ICON[t]; b.title = LABEL[t];
      b.setAttribute("aria-label", LABEL[t] + ". Switch to " + NEXT[t]);
    });
  }
  function changed() { document.dispatchEvent(new CustomEvent("themechange")); }
  apply(get());
  document.addEventListener("DOMContentLoaded", function () {
    paint();
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-theme-toggle]");
      if (!b) return;
      var n = NEXT[get()];
      try { if (n === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, n); } catch (err) {}
      apply(n); paint(); changed();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", function () { if (get() === "system") changed(); });
    }
  });
})();
