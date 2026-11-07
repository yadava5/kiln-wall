// Mission Map has one preset and one look (Foundry): nothing here changes what it draws.
// The file stays so the host's live-reload of config.js keeps working; the temperature
// unit comes from the host's menu, not from here.
window.MISSIONMAP = {
  preset: "foundry",
  presets: {
    foundry: {},
  },
};
