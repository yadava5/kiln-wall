// Glass Control Room presets. Edit and save: the host reloads the page.
// A query string wins over this file in dev (?preset=machine, ?theme=day).
window.GLASS_CONFIG = {
  // control  the full room: limit, needs you, sessions, agents | window | tokens, Mac, I/O, GitHub
  // focus    the weekly limit, needs you and the window only
  // machine  the right wing swaps GitHub for per-process lists (top CPU, top memory)
  // week     the right wing swaps This Mac and I/O for the last 14 days
  // share    screen-share safe: hides session names, tasks, questions and repo names; keeps figures
  preset: "control",

  // sun      night or day glass follows sunrise and sunset (state.weather.is_day)
  // system   follows the macOS appearance (prefers-color-scheme)
  // night    always the dark glass
  // day      always the pale glass
  theme: "sun",

  // Window weather. Beads on the glass and falling rain or snow; false keeps the sky and
  // clouds but stops precipitation and beads (the clouds still drift with the wind).
  precipitation: true,
};
