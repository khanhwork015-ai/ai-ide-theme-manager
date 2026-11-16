# AGENTS.md — AI Agent Self-Installation & Theme Guide

This repository is **AI IDE Theme Manager**, designed to be installed, customized, and maintained automatically by AI coding agents (**Codex**, **Claude Code**, **Cursor**, **Gemini CLI**, **Antigravity**).

## 1. Zero-Touch Installation Workflow (Run when user asks to install)

When a user gives you this repo URL and asks to install or set up the theme manager:

1. **Check Prerequisites:**
   - `node -v` (Node.js `>= 20` required; `>= 22` has native `WebSocket`, Node `20–21` uses `--experimental-websocket`).
   - `python --version` or `python3 --version` (Python 3.9+ required).
2. **Build the Runtime Payload:**
   ```bash
   python scripts/build_payload.py   # or python3 scripts/build_payload.py
   ```
   Syntax-check:
   ```bash
   node --check dist/theme_payload.js
   node --check daemon/theme_daemon.js
   ```
3. **Install & Start the Background Daemon:**
   - **Windows (PowerShell):**
     ```powershell
     powershell -ExecutionPolicy Bypass -File scripts/install-win.ps1
     ```
     *(Use `-NoStartup` if the user does not want a Windows Startup shortcut.)*
   - **macOS / Linux:**
     ```bash
     bash scripts/install-unix.sh
     ```
4. **Verify Live Injection (Antigravity IDE must be running):**
   - Node `>= 22`: `node scripts/verify_cdp.js`
   - Node `20–21`: `node --experimental-websocket scripts/verify_cdp.js`
   - Confirm `"themeActive": true`, `"quickDockPresent": true`, and `"hasLiveBlurRule": false`.

## 2. Features Available to the User
- **Quick Dock (Top-Right Header):**
  - `⚡ <Theme>`: 1-click cycle through themes (`Ctrl+Shift+T`)
  - `🎨`: Open **Antigravity Theme Manager** modal
  - `⏻`: Safe Master On/Off kill-switch (`Ctrl+Shift+Alt+T`) — cleanly removes injected styles without stopping the daemon
- **Prompt-to-Theme Studio:** Built into the `🎨` modal. Uses `GEMINI_API_KEY` if available in environment, or an offline semantic palette generator with WCAG Contrast Guard. Saves to `themes/custom_themes.json`.

## 3. Architecture Rules
- **Zero Live Blur:** Never add CSS `backdrop-filter: blur(...)` to `.agy-shell`, `.agy-chat-frame`, or scrollable panes.
- **Keep Menus Opaque:** `.surface-opaque`, `[role="menu"]`, `[role="listbox"]`, `.bg-popover` must remain opaque (`modalBg`) with `cursor: pointer`.
- **No Personal Data:** Never commit `theme_config.json`, `daemon.pid`, `daemon.log`, `dist/`, or hardcoded user paths (`C:\Users\...`, `/Users/...`).
