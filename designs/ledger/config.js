// The Ledger: presets. Edit and save; the host reloads the page.
// Dev overrides in the URL win over these: ?edition= ?layout= ?weather= ?sky=
window.LEDGER_CONFIG = {
  // auto prints the Night edition from the real sunset to the real sunrise
  // (state.weather) and the Day edition between them. night or day pins one.
  edition: "auto", // auto | night | day

  // daily: the full page.
  // weekend: drops the machine and enlarges the fourteen days.
  // brief: the lead, the ear and the clock only.
  // auto: daily on weekdays, weekend on Saturday and Sunday (by state.t).
  layout: "daily", // daily | weekend | brief | auto

  // The cross-fade between editions at sunrise and sunset, in seconds.
  fade_s: 8,

  // The rain and snow in the weather plate. false holds them still; every
  // figure still updates.
  weather_motion: true,
};
