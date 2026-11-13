# Jukebox

A touchscreen jukebox for big screens (built for a 55" panel), in a 1950s/60s cabinet style.
It plays from a **Jellyfin** server, **local music folders** and **YouTube Music**, all into one queue.

![Jukebox](screenshot.png)

## Download
Get the latest files from **[Releases](../../releases/latest)**:

| System | File |
|---|---|
| Windows (installer) | `Jukebox-Setup-1.1.0.exe` |
| Windows (no install) | `Jukebox-1.1.0-portable.exe` |
| Linux (any distro) | `Jukebox-1.1.0.AppImage`, then `chmod +x` it and run |
| Debian / Ubuntu | `jukebox_1.1.0_amd64.deb`, then `sudo apt install ./jukebox_1.1.0_amd64.deb` |

These builds aren't signed, so Windows SmartScreen will warn the first time: click **More info → Run anyway**.

## Setup
Tap ⚙ (top right):
- **Jellyfin:** enter the server address (e.g. `http://192.168.1.10:8096`), username and password
- **Local folders:** add a folder, and the app scans its tags and cover art
- **YouTube Music:** works straight away (with ads); sign in with a Premium account to remove them
- **Operator PIN:** set one so guests can't change settings

Operator keys: `F11` toggles fullscreen, `Ctrl+Shift+Q` quits (also in kiosk mode).
