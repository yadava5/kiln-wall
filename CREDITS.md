# Credits

KilnWall's own code is MIT (see [LICENSE](LICENSE)). The following parts are other people's work, under their own terms.

## Fonts

Every bundled font is under the SIL Open Font License 1.1. Its licence text sits in the design's `fonts/` folder.

| Font | Used by | Copyright | Licence file |
|---|---|---|---|
| Bricolage Grotesque | bento | 2022 The Bricolage Grotesque Project Authors | `designs/bento/fonts/OFL-BricolageGrotesque.txt` |
| Instrument Sans | bento | 2022 The Instrument Sans Project Authors | `designs/bento/fonts/OFL-InstrumentSans.txt` |
| B612, B612 Mono | flightdeck | 2012 The B612 Project Authors | `designs/flightdeck/fonts/OFL.txt` |
| Atkinson Hyperlegible Next | glass | 2020–2024 The Atkinson Hyperlegible Next Project Authors | `designs/glass/fonts/OFL-AtkinsonHyperlegibleNext.txt` |
| Red Hat Display | glass | 2024 The Red Hat Project Authors | `designs/glass/fonts/OFL-RedHatDisplay.txt` |
| Archivo | horizon | 2020 The Archivo Project Authors | `designs/horizon/fonts/OFL-Archivo.txt` |
| Newsreader | ledger | 2020 The Newsreader Project Authors | `designs/ledger/fonts/OFL.txt` |
| Schibsted Grotesk | ledger | 2023 The Schibsted-Grotesk Project Authors | `designs/ledger/fonts/OFL.txt` |
| Fraunces | missionmap | 2018 The Fraunces Project Authors | `designs/missionmap/fonts/OFL-Fraunces.txt` |
| Hanken Grotesk | missionmap | 2021 The Hanken Grotesk Project Authors | `designs/missionmap/fonts/OFL-HankenGrotesk.txt` |
| Geist Mono | missionmap, patchbay | 2023 Vercel, in collaboration with basement.studio | `designs/missionmap/fonts/OFL-GeistMono.txt`, `designs/patchbay/fonts/LICENSE-geist.txt` |
| Barlow, Barlow Condensed | patchbay | 2017 The Barlow Project Authors | `designs/patchbay/fonts/OFL-barlow.txt` |

Ledger's Schibsted Grotesk files are modified: `designs/ledger/fonts/tnum_digits_only.py` restricts the tabular-figures feature to the ten digits. That is permitted by OFL 1.1, and the modified files keep the same licence.

## Map and terrain

**Mission Map's ground and horizon** (`designs/missionmap/ground.js`, `horizon.js`) are contours computed by `ground-gen.py` and `horizon-gen.py`. They come from elevation data in the [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium encoding), whose US coverage comes from USGS 3DEP. USGS data is in the public domain. For the tiles' source attributions, see the [Terrain Tiles attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

## Ledger's weather plate

The small engraved scene in `designs/ledger/vignette.js` is drawn from, not traced from, these Wikimedia Commons photographs:

- *Beta Bell Tower from the west n.d. (3193544163).jpg*: Miami University Libraries, no known restrictions.
- *Muohiobelltower.jpg*: public domain.
- *Upham Hall Arch Miami University Oxford Ohio.jpg*: CC BY-SA 3.0.

The composition is invented. The vane on the tower is a liberty, added so the wind has somewhere to show.

## Data the feed reads at runtime

- **Weather.** The feed's weather block uses [Open-Meteo](https://open-meteo.com/). It is off unless `KILN_LAT` and `KILN_LON` are set. Open-Meteo's data is licensed CC BY 4.0, with the credit "Weather data by Open-Meteo.com".
- **GitHub.** The GitHub block uses the GitHub GraphQL API with your own token.
- **Claude Code.** Claude Code's usage is read from your local `~/.claude` folder. Nothing is sent anywhere.

## Demo data

Every screenshot and animation in this repository uses the synthetic, seeded fixture in `designs/_shared/fixture.js`, which `demo/make-fixture.mjs` generates. The sessions, repos, the GitHub user `demo-user` and "Demo City" are invented.
