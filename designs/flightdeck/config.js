// Flight Deck presets, from the round-2 notes. Pick one with `preset`; the host reloads the
// page when this file changes. `?preset=approach` overrides it in the dev loop.
window.FD_CONFIG = {
  preset: "cruise",
  presets: {
    // everything, as approved
    cruise: {},
    // only the weekly limit, the lamps, the sessions and the clock row; the other displays go dark
    approach: { hide: ["tape", "cpu", "flow", "sys", "lower"] },
    // the whole deck at 70% from 11 pm until sunrise (6 am when the weather feed is down)
    night: { dimFrom: 23, dim: 0.3 },
    // the primary gauge reads memory; the weekly limit moves to the systems column
    maintenance: { gauge: "memory" },
  },
  // fuel plan: the last N% of the weekly limit is drawn as reserve. A planning setting, not a measurement.
  reservePct: 10,
};
