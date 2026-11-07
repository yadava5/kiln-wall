// Bento Keynote presets. Pick one with `preset`; editing this file live-reloads the wallpaper.
//   theme:   "auto" follows the sun: Keynote light from sunrise to sunset, Keynote dark after
//            (from state.weather; with no weather reading, the system appearance decides).
//            "dark" or "light" pins it. "system" always follows the system appearance.
//   layout:  "keynote" (the approved grid), "focus" (weekly, needs you, weather and sessions
//            only, larger), "github" (the calendar takes the top row), "machine" (agents and
//            14 days give way to GPU and top processes).
//   private: true hides session names, tasks, questions and repo names; the hero figures stay.
window.BENTO_CONFIG = {
  preset: "keynote",
  presets: {
    keynote: { theme: "auto", layout: "keynote" },
    "keynote-dark": { theme: "dark", layout: "keynote" },
    "keynote-light": { theme: "light", layout: "keynote" },
    focus: { theme: "auto", layout: "focus" },
    "github-week": { theme: "auto", layout: "github" },
    machine: { theme: "auto", layout: "machine" },
    "screen-share": { theme: "auto", layout: "keynote", private: true },
  },
};
