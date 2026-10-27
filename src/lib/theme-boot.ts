/**
 * Runs before first paint so the page never flashes the wrong theme.
 *
 * Shared by the root layout and the offline export template: a standalone file
 * has no Next runtime, and the two copies must not drift.
 */
export const THEME_BOOT =
  "(function(){try{var m=localStorage.getItem('arena-theme')||'auto';" +
  "var d=m==='auto'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m;" +
  "var e=document.documentElement;e.dataset.theme=d;e.dataset.mode=m;}catch(_){}})();";
