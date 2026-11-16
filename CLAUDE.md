# CLAUDE.md — Claude Code Instructions

See [AGENTS.md](./AGENTS.md) and [SKILL.md](./SKILL.md) for the complete installation and theme-authoring workflow.

## Quick Commands for Claude Code

1. **Build & Verify Syntax:**
   - `python scripts/build_payload.py` (or `python3 scripts/build_payload.py`)
   - `node --check dist/theme_payload.js && node --check daemon/theme_daemon.js`
2. **Start / Restart Daemon:**
   - Windows: `powershell -ExecutionPolicy Bypass -File scripts/install-win.ps1`
   - macOS / Linux: `bash scripts/install-unix.sh`
3. **Live CDP Verification:**
   - Node `>= 22`: `node scripts/verify_cdp.js`
   - Node `20–21`: `node --experimental-websocket scripts/verify_cdp.js`
4. **Adding a New Theme from User Image or Prompt:**
   - Save image under `themes/assets/<slug>.jpg` (or `.png` / `.webp`)
   - Add preset entry in `themes/themes.json` (follow `references/theme-schema.md`)
   - Rebuild `dist/theme_payload.py` -> restart daemon -> run `verify_cdp.js`.
