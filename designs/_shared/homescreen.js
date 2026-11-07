// A real home screen, drawn over a concept when the URL has ?home.
// Measured 2026-11-04 on a MacBook Pro 14 (1512x982 pt, NSScreen):
//  - notch: x 663..848 (185 pt wide), 32 pt tall, top centre. Nothing drawn
//    there is ever visible.
//  - menu bar: AUTO-HIDES (_HIHideMenuBar=1), so the strip either side of
//    the notch is wallpaper; it is covered only while the pointer is at the top.
//  - Dock: LEFT edge, always visible, 38 pt tiles, visibleFrame starts at
//    x=58, so the left 58 pt is Dock territory where the Dock is.
//    12 icons: Finder, Safari, Messages, FaceTime, Mail, Photos, Notes,
//    System Settings, kitty | Google Chrome, Preview (running) | Trash.
//  - Desktop icons: hidden (Finder CreateDesktop=false). None to avoid.
(function () {
  if (!/[?&]home\b/.test(location.search)) return;
  const kit = document.currentScript.src.replace(/homescreen\.js.*$/, "");
  const css = `
  .hs-notch{position:fixed;left:663px;top:0;width:185px;height:32px;background:#000;
    border-radius:0 0 11px 11px;z-index:99999;pointer-events:none}
  .hs-dock{position:fixed;left:4px;top:50%;transform:translateY(-50%);width:50px;
    padding:7px 0;border-radius:16px;z-index:99998;display:flex;flex-direction:column;
    align-items:center;gap:3px;background:rgba(48,48,54,.42);
    -webkit-backdrop-filter:blur(28px) saturate(1.6);backdrop-filter:blur(28px) saturate(1.6);
    box-shadow:inset 0 0 0 .5px rgba(255,255,255,.22),0 10px 30px rgba(0,0,0,.35)}
  .hs-dock img{width:38px;height:38px;display:block}
  .hs-dock .it{position:relative}
  .hs-dock .it.run::before{content:"";position:absolute;left:-5px;top:17px;width:3px;height:3px;
    border-radius:50%;background:rgba(255,255,255,.75)}
  .hs-dock hr{width:30px;border:0;border-top:1px solid rgba(255,255,255,.22);margin:4px 0}`;
  const st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);
  const n = document.createElement("div");
  n.className = "hs-notch";
  document.body.appendChild(n);
  const groups = [["Finder", "Safari", "Messages", "FaceTime", "Mail", "Photos", "Notes",
    "System Settings", "kitty"], ["Google Chrome", "Preview"], ["Trash"]];
  const run = new Set(["Finder", "Safari", "Notes", "kitty", "Google Chrome", "Preview"]);
  const d = document.createElement("div");
  d.className = "hs-dock";
  groups.forEach((g, i) => {
    if (i) d.appendChild(document.createElement("hr"));
    g.forEach((a) => {
      const w = document.createElement("div");
      w.className = "it" + (run.has(a) ? " run" : "");
      const im = document.createElement("img");
      // App icons are third-party artwork and are not shipped: drop a dock/<App>.png in
      // locally for a faithful preview. Without one the tile is a plain rounded square.
      im.onerror = () => { im.replaceWith(Object.assign(document.createElement("span"), {
        style: "width:38px;height:38px;display:block;border-radius:9px;background:rgba(235,235,245,.28)" })); };
      im.src = kit + "dock/" + encodeURIComponent(a) + ".png";
      w.appendChild(im);
      d.appendChild(w);
    });
  });
  document.body.appendChild(d);
})();
