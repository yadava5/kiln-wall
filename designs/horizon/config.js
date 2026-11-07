// Horizon presets. Edit `preset` and save; the host live-reloads the design.
// A dev override for any of them: index.html?fixture&preset=quiet
//   auto   the sky follows the real sun: night after sunset, day by the sun's altitude.
//   night  always the night sky (the v2 still), whatever the sun is doing.
//   day    always the daylight sky, whatever the sun is doing.
//   quiet  auto sky; no falling rain or snow, no lightning, values jump instead of gliding.
//   focus  only the gate and the now rate; everything else recedes into the fog.
window.HORIZON_CONFIG = {
  preset: "auto",
  presets: {
    auto: { sky: "sun", motion: true, focus: false },
    night: { sky: "night", motion: true, focus: false },
    day: { sky: "day", motion: true, focus: false },
    quiet: { sky: "sun", motion: false, focus: false },
    focus: { sky: "sun", motion: true, focus: true },
  },
};
