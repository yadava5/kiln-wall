// looks.mjs: every look of every design, for the demo tools. A design with a light and a dark look
// (bento, glass, ledger) is forced into each with ?appearance=; the rest have one look.
export const LOOKS = [
  { id: "bento-light", design: "bento", query: "appearance=light" },
  { id: "bento-dark", design: "bento", query: "appearance=dark" },
  { id: "flightdeck", design: "flightdeck", query: "" },
  { id: "glass-light", design: "glass", query: "appearance=light" },
  { id: "glass-dark", design: "glass", query: "appearance=dark" },
  { id: "horizon", design: "horizon", query: "" },
  { id: "ledger-light", design: "ledger", query: "appearance=light" },
  { id: "ledger-dark", design: "ledger", query: "appearance=dark" },
  { id: "missionmap", design: "missionmap", query: "" },
  { id: "patchbay", design: "patchbay", query: "" },
];
