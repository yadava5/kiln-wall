# Security

KilnWall runs locally. Its feed reads your Claude Code folder (`~/.claude`) and machine statistics, and sends nothing anywhere except two optional requests:

- **Weather**, to Open-Meteo. It sends only the latitude and longitude you set.
- **Contributions**, to GitHub's API, using your own token.

The wallpaper page is loaded from local files and makes no network requests of its own.

To report a vulnerability, use GitHub's private reporting on this repository (**Security → Report a vulnerability**). Please don't open a public issue.
