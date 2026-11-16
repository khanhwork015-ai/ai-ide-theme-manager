#!/usr/bin/env node
'use strict';

/**
 * Antigravity Custom Theme Daemon (Windows / macOS / Linux)
 * Connects to Antigravity CDP (DevToolsActivePort), injects dist/theme_payload.js,
 * persists user theme preferences in theme_config.json, and hot-reloads on rebuild.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

if (typeof globalThis.WebSocket !== 'function') {
    console.error('[theme-daemon] Node.js >= 22 (or Node 20 with --experimental-websocket) is required.');
    process.exit(1);
}

const ROOT_DIR = path.resolve(__dirname, '..');
const PID_FILE = path.join(ROOT_DIR, 'daemon.pid');
const CONFIG_FILE = process.env.AGY_CONFIG_PATH || path.join(ROOT_DIR, 'theme_config.json');
const CUSTOM_THEMES_FILE = path.join(ROOT_DIR, 'themes', 'custom_themes.json');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PAYLOAD_PATH = path.join(DIST_DIR, 'theme_payload.js');
const LOG_FILE = path.join(ROOT_DIR, 'daemon.log');
const DEFAULT_CONFIG = { themeEnabled: true };

function resolvePortFile() {
    if (process.env.AGY_PORT_FILE) {
        return process.env.AGY_PORT_FILE;
    }

    const home = os.homedir();
    let candidates;
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        candidates = [
            path.join(appData, 'antigravity', 'DevToolsActivePort'),
            path.join(appData, 'Antigravity', 'DevToolsActivePort'),
        ];
    } else if (process.platform === 'darwin') {
        const appSupport = path.join(home, 'Library', 'Application Support');
        candidates = [
            path.join(appSupport, 'antigravity', 'DevToolsActivePort'),
            path.join(appSupport, 'Antigravity', 'DevToolsActivePort'),
        ];
    } else {
        const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        candidates = [
            path.join(xdgConfig, 'antigravity', 'DevToolsActivePort'),
            path.join(xdgConfig, 'Antigravity', 'DevToolsActivePort'),
        ];
    }

    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) {
            fs.writeFileSync(LOG_FILE, '');
        }
        fs.appendFileSync(LOG_FILE, line);
    } catch (_) {}
    if (process.stdout.isTTY || process.env.AGY_DAEMON_STDOUT === '1') {
        process.stdout.write(line);
    }
}

function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function acquirePidLock() {
    if (fs.existsSync(PID_FILE)) {
        const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
            log(`Another daemon instance is already running (PID ${existingPid}). Exiting.`);
            process.exit(0);
        }
    }
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

function removePidLock() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
            if (pid === process.pid) {
                fs.unlinkSync(PID_FILE);
            }
        }
    } catch (_) {}
}

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            if (parsed && typeof parsed === 'object') {
                return { ...DEFAULT_CONFIG, ...parsed };
            }
        }
    } catch (err) {
        log(`Failed reading theme_config.json: ${err.message}`);
    }
    return { ...DEFAULT_CONFIG };
}

function saveConfig(next) {
    try {
        const merged = { ...readConfig(), ...next };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
        return merged;
    } catch (err) {
        log(`Failed saving theme_config.json: ${err.message}`);
        return null;
    }
}

function readCustomThemes() {
    try {
        if (fs.existsSync(CUSTOM_THEMES_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(CUSTOM_THEMES_FILE, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
    } catch (err) {
        log(`Failed reading custom_themes.json: ${err.message}`);
    }
    return {};
}

function saveCustomThemes(nextThemes) {
    try {
        fs.mkdirSync(path.dirname(CUSTOM_THEMES_FILE), { recursive: true });
        fs.writeFileSync(CUSTOM_THEMES_FILE, JSON.stringify(nextThemes, null, 2), 'utf8');
        return true;
    } catch (err) {
        log(`Failed saving custom_themes.json: ${err.message}`);
        return false;
    }
}

function hexToRgb(hex) {
    const clean = String(hex || '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
    return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
    ];
}

function applyWcagContrastGuard(themeObj, isLight) {
    const t = { ...themeObj, isLight: Boolean(isLight) };
    if (t.isLight) {
        t.textColor = '#0f172a';
        t.uiTextColor = '#0f172a';
        t.uiMutedColor = '#334155';
        t.pillTextColor = '#0f172a';
        t.sidebarEnhanceText = false;
    } else {
        t.textColor = '#f8fafc';
        t.uiTextColor = '#f8fafc';
        t.uiMutedColor = '#cbd5e1';
        t.pillTextColor = '#f8fafc';
    }
    t.clearBackdrop = true;
    t.unifiedGlass = false;
    t.isOrnament = false;
    t.wallpaper = t.wallpaper || '';
    return t;
}

function generateThemeLocally(prompt, customName) {
    const p = String(prompt || '').toLowerCase();
    const isLight = /\b(light|day|pastel|white|cream|sakura|matcha|snow|bright|sáng|trắng|ban ngày)\b/.test(p);

    const palettes = [
        { re: /cyber|neon|magenta|pink|synth|vapor|tím|hồng/, primary: '#22d3ee', secondary: '#f472b6', baseDark: '#070916', baseLight: '#fff5f8' },
        { re: /gold|thunder|lightning|sun|amber|zenitsu|vàng|sấm|nắng/, primary: '#facc15', secondary: '#f97316', baseDark: '#0a0906', baseLight: '#fffbeb' },
        { re: /forest|matcha|green|emerald|nature|jade|xanh lá|rừng|cây/, primary: isLight ? '#15803d' : '#34d399', secondary: isLight ? '#0d9488' : '#a3e635', baseDark: '#06120d', baseLight: '#f3faf4' },
        { re: /ocean|sea|blue|ice|frost|arctic|water|xanh dương|biển|băng/, primary: isLight ? '#0369a1' : '#38bdf8', secondary: isLight ? '#0284c7' : '#818cf8', baseDark: '#060d18', baseLight: '#f0f9ff' },
        { re: /crimson|blood|red|fire|ember|lava|đỏ|lửa/, primary: isLight ? '#be123c' : '#fb7185', secondary: isLight ? '#ea580c' : '#f97316', baseDark: '#14080a', baseLight: '#fff1f2' },
        { re: /violet|purple|cosmic|galaxy|space|lavender|vũ trụ/, primary: isLight ? '#6d28d9' : '#a78bfa', secondary: isLight ? '#db2777' : '#38bdf8', baseDark: '#0b0917', baseLight: '#f5f3ff' },
    ];

    let chosen = palettes.find((item) => item.re.test(p));
    if (!chosen) {
        let hash = 0;
        for (let i = 0; i < p.length; i++) hash = ((hash << 5) - hash + p.charCodeAt(i)) | 0;
        chosen = palettes[Math.abs(hash) % palettes.length];
    }

    const pRgb = hexToRgb(chosen.primary) || [96, 165, 250];
    const sRgb = hexToRgb(chosen.secondary) || [167, 139, 250];
    const baseHex = isLight ? chosen.baseLight : chosen.baseDark;
    const baseRgb = hexToRgb(baseHex) || (isLight ? [246, 248, 252] : [10, 12, 20]);
    const [br, bg, bb] = baseRgb;

    const rawName = String(customName || '').trim() ||
        String(prompt || 'Custom Prompt').trim().split(/\s+/).slice(0, 4).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    const theme = applyWcagContrastGuard({
        concept: `Prompt: ${String(prompt || '').trim().slice(0, 48)}`,
        primary: chosen.primary,
        secondary: chosen.secondary,
        glow: `rgba(${pRgb.join(', ')}, ${isLight ? 0.18 : 0.26})`,
        secondaryGlow: `rgba(${sRgb.join(', ')}, ${isLight ? 0.15 : 0.20})`,
        bg: isLight
            ? `linear-gradient(145deg, rgba(255, 255, 255, 0.92) 0%, rgba(${br}, ${bg}, ${bb}, 0.96) 100%)`
            : `linear-gradient(145deg, rgba(${br + 10}, ${bg + 12}, ${bb + 18}, 0.90) 0%, rgba(${br}, ${bg}, ${bb}, 0.95) 100%)`,
        frameBg: `linear-gradient(135deg, rgba(${pRgb.join(', ')}, ${isLight ? 0.52 : 0.72}) 0%, rgba(${sRgb.join(', ')}, ${isLight ? 0.44 : 0.56}) 100%)`,
        borderColor: `rgba(${pRgb.join(', ')}, ${isLight ? 0.28 : 0.36})`,
        innerBorder: `1px solid rgba(${pRgb.join(', ')}, 0.18)`,
        overlayRgb: `${br}, ${bg}, ${bb}`,
        pureBg: `radial-gradient(circle at 78% 20%, rgba(${pRgb.join(', ')}, ${isLight ? 0.28 : 0.22}) 0%, transparent 55%), radial-gradient(circle at 20% 80%, rgba(${sRgb.join(', ')}, ${isLight ? 0.22 : 0.16}) 0%, transparent 52%), linear-gradient(160deg, ${baseHex} 0%, ${isLight ? '#ffffff' : '#05070d'} 100%)`,
        sidebarBg: `rgba(${br}, ${bg}, ${bb}, ${isLight ? 0.74 : 0.48})`,
        sidebarHoverBg: `rgba(${pRgb.join(', ')}, ${isLight ? 0.10 : 0.15})`,
        aiCardBg: isLight ? 'rgba(255, 255, 255, 0.82)' : `rgba(${br + 4}, ${bg + 6}, ${bb + 10}, 0.76)`,
        aiCardBorder: `rgba(${pRgb.join(', ')}, 0.18)`,
        headerBg: `rgba(${br}, ${bg}, ${bb}, ${isLight ? 0.74 : 0.48})`,
        headerBorder: `rgba(${pRgb.join(', ')}, 0.12)`,
        btnBg: isLight ? `rgba(${br - 12}, ${bg - 10}, ${bb - 8}, 0.88)` : `rgba(${br + 16}, ${bg + 20}, ${bb + 28}, 0.66)`,
        inputGlassBg: isLight ? 'rgba(255, 255, 255, 0.80)' : `rgba(${br}, ${bg}, ${bb}, 0.62)`,
        inputCardBg: isLight
            ? `linear-gradient(145deg, rgba(255, 255, 255, 0.94) 0%, rgba(${br}, ${bg}, ${bb}, 0.96) 100%)`
            : `linear-gradient(145deg, rgba(${br + 10}, ${bg + 12}, ${bb + 18}, 0.90) 0%, rgba(${br}, ${bg}, ${bb}, 0.95) 100%)`,
        modalBg: `rgba(${br}, ${bg}, ${bb}, 0.97)`,
        modalHeaderBg: isLight ? `rgba(${br - 8}, ${bg - 6}, ${bb - 4}, 0.95)` : `rgba(${br + 8}, ${bg + 10}, ${bb + 16}, 0.90)`,
        cardBg: isLight ? 'rgba(255, 255, 255, 0.88)' : `rgba(${br + 6}, ${bg + 8}, ${bb + 14}, 0.84)`,
        cardSelectedBg: `rgba(${pRgb.join(', ')}, ${isLight ? 0.18 : 0.24})`,
        pillBg: isLight ? `rgba(${br - 10}, ${bg - 8}, ${bb - 6}, 0.88)` : `rgba(${br + 14}, ${bg + 18}, ${bb + 26}, 0.70)`,
        pillHoverBg: `rgba(${pRgb.join(', ')}, 0.22)`,
        pillBorder: `rgba(${pRgb.join(', ')}, 0.26)`,
        isCustom: true,
    }, isLight);

    return { name: rawName, theme };
}

function callGeminiThemeApi(prompt, customName) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return Promise.resolve(null);

    const sysInstruction = [
        'Return ONLY a valid JSON object with keys: name (string), isLight (boolean), primary (hex), secondary (hex), overlayRgb ("R, G, B"), pureBg (css multi-layer radial+linear gradient), concept (short string <= 45 chars).',
        'Ensure high visual aesthetic matching the user prompt.',
    ].join(' ');

    const body = JSON.stringify({
        contents: [{ parts: [{ text: `${sysInstruction}\nUser prompt: ${prompt}${customName ? `\nPreferred name: ${customName}` : ''}` }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
    });

    return new Promise((resolve) => {
        const req = https.request(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000 },
            (res) => {
                let raw = '';
                res.on('data', (c) => { raw += c; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(raw);
                        const txt = json?.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (!txt) return resolve(null);
                        const spec = JSON.parse(txt);
                        if (!spec.primary || !spec.secondary) return resolve(null);
                        const base = generateThemeLocally(prompt, spec.name || customName);
                        const merged = applyWcagContrastGuard({
                            ...base.theme,
                            concept: spec.concept || base.theme.concept,
                            primary: spec.primary,
                            secondary: spec.secondary,
                            overlayRgb: spec.overlayRgb || base.theme.overlayRgb,
                            pureBg: spec.pureBg || base.theme.pureBg,
                        }, Boolean(spec.isLight));
                        resolve({ name: String(spec.name || base.name).trim(), theme: merged });
                    } catch (_) {
                        resolve(null);
                    }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(body);
        req.end();
    });
}

let missingPayloadLogged = false;
function buildInjectedSource() {
    if (!fs.existsSync(PAYLOAD_PATH)) {
        if (!missingPayloadLogged) {
            log(`Payload not built yet (${PAYLOAD_PATH}). Run: python scripts/build_payload.py`);
            missingPayloadLogged = true;
        }
        return null;
    }
    missingPayloadLogged = false;

    const cfgJson = JSON.stringify(readConfig());
    const customThemesJson = JSON.stringify(readCustomThemes());
    const payloadCode = fs.readFileSync(PAYLOAD_PATH, 'utf8');
    return `window.__AGY_INITIAL_CONFIG__ = ${cfgJson};\nwindow.__AGY_CUSTOM_THEMES__ = ${customThemesJson};\n${payloadCode}`;
}

function getPortInfo() {
    const portFile = resolvePortFile();
    if (!fs.existsSync(portFile)) return null;
    const lines = fs
        .readFileSync(portFile, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    const port = parseInt(lines[0], 10);
    if (!Number.isFinite(port) || port <= 0) return null;
    return { port, token: lines[1] || '' };
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
        req.on('error', reject);
    });
}

const sessions = new Map();
let lastPort = null;
let reloadTimer = null;

function createSession(target) {
    const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    const session = { id: target.id, ws, target };
    sessions.set(target.id, session);

    function send(method, params = {}) {
        return new Promise((resolve, reject) => {
            if (ws.readyState !== 1) {
                reject(new Error('WebSocket is not open'));
                return;
            }
            const id = nextId++;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    session.reinject = async () => {
        const src = buildInjectedSource();
        if (!src) return;
        try {
            await send('Runtime.evaluate', { expression: src, awaitPromise: false });
        } catch (_) {}
    };

    ws.addEventListener('message', async (event) => {
        let msg;
        try {
            msg = JSON.parse(String(event.data));
        } catch (_) {
            return;
        }

        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
            else p.resolve(msg.result);
            return;
        }

        if (msg.method === 'Runtime.bindingCalled' && msg.params) {
            const bName = msg.params.name;
            if (bName === 'agySaveThemeConfig') {
                try {
                    const payload = JSON.parse(msg.params.payload || '{}');
                    saveConfig(payload);
                    for (const other of sessions.values()) {
                        if (other.id !== target.id) {
                            other.reinject();
                        }
                    }
                } catch (err) {
                    log(`Config binding error: ${err.message}`);
                }
                return;
            }
            if (bName === 'agyGenerateThemeFromPrompt') {
                try {
                    const req = JSON.parse(msg.params.payload || '{}');
                    const prompt = String(req.prompt || '').trim();
                    const customName = String(req.name || '').trim();
                    if (!prompt) return;
                    const generated = (await callGeminiThemeApi(prompt, customName)) || generateThemeLocally(prompt, customName);
                    const allCustom = readCustomThemes();
                    allCustom[generated.name] = generated.theme;
                    saveCustomThemes(allCustom);
                    saveConfig({
                        themeName: generated.name,
                        bubbleName: generated.name,
                        themeEnabled: true,
                        customWp: '',
                    });
                    log(`Generated custom theme "${generated.name}" from prompt.`);
                    for (const s of sessions.values()) {
                        await s.reinject();
                    }
                } catch (err) {
                    log(`Prompt theme error: ${err.message}`);
                }
                return;
            }
            if (bName === 'agyDeleteCustomTheme') {
                try {
                    const req = JSON.parse(msg.params.payload || '{}');
                    const name = String(req.name || '').trim();
                    const allCustom = readCustomThemes();
                    if (name && allCustom[name]) {
                        delete allCustom[name];
                        saveCustomThemes(allCustom);
                        const cfg = readConfig();
                        if (cfg.themeName === name) {
                            saveConfig({ themeName: '', bubbleName: '' });
                        }
                        log(`Deleted custom theme "${name}".`);
                        for (const s of sessions.values()) {
                            await s.reinject();
                        }
                    }
                } catch (err) {
                    log(`Delete theme error: ${err.message}`);
                }
                return;
            }
        }

        if (msg.method === 'Page.frameNavigated' && msg.params && msg.params.frame && !msg.params.frame.parentId) {
            await session.reinject();
        }
    });

    ws.addEventListener('open', async () => {
        try {
            await send('Page.enable');
            await send('Runtime.enable');
            try {
                await send('Runtime.addBinding', { name: 'agySaveThemeConfig' });
                await send('Runtime.addBinding', { name: 'agyGenerateThemeFromPrompt' });
                await send('Runtime.addBinding', { name: 'agyDeleteCustomTheme' });
            } catch (_) {}

            const src = buildInjectedSource();
            if (src) {
                await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
                await send('Runtime.evaluate', { expression: src, awaitPromise: false });
            }
            log(`Attached target ${target.id} (${target.url})`);
        } catch (err) {
            log(`Attach error for ${target.id}: ${err.message}`);
        }
    });

    const cleanup = () => {
        for (const p of pending.values()) {
            p.reject(new Error('WebSocket closed'));
        }
        pending.clear();
        sessions.delete(target.id);
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
}

async function scanPages() {
    const info = getPortInfo();
    if (!info) return;

    if (lastPort !== null && lastPort !== info.port) {
        for (const s of sessions.values()) {
            try {
                s.ws.close();
            } catch (_) {}
        }
        sessions.clear();
    }
    lastPort = info.port;

    let targets;
    try {
        targets = await fetchJson(`http://127.0.0.1:${info.port}/json`);
    } catch (_) {
        return;
    }
    if (!Array.isArray(targets)) return;

    const pages = targets.filter((t) => {
        if (!t || t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
        const url = String(t.url || '');
        if (url.startsWith('devtools://') || url.startsWith('chrome-extension://')) return false;
        return url.includes('127.0.0.1') || url.includes('workbench') || url.includes('launchpad');
    });

    const liveIds = new Set(pages.map((p) => p.id));
    for (const [id, session] of sessions.entries()) {
        if (!liveIds.has(id)) {
            try {
                session.ws.close();
            } catch (_) {}
            sessions.delete(id);
        }
    }

    for (const page of pages) {
        if (!sessions.has(page.id)) {
            createSession(page);
        }
    }
}

function watchPayload() {
    try {
        if (!fs.existsSync(DIST_DIR)) {
            fs.mkdirSync(DIST_DIR, { recursive: true });
        }
        fs.watch(DIST_DIR, (_eventType, filename) => {
            if (filename && filename !== 'theme_payload.js') return;
            clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => {
                log('Detected dist/theme_payload.js update; hot-reloading attached pages.');
                for (const s of sessions.values()) {
                    s.reinject();
                }
            }, 250);
        });
    } catch (err) {
        log(`fs.watch skipped: ${err.message}`);
    }
}

function shutdown(signal) {
    log(`Shutting down on ${signal}.`);
    for (const s of sessions.values()) {
        try {
            s.ws.close();
        } catch (_) {}
    }
    sessions.clear();
    removePidLock();
    process.exit(0);
}

acquirePidLock();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', removePidLock);

log(`Theme daemon started (PID ${process.pid}, platform=${process.platform}, portFile=${resolvePortFile()}).`);
watchPayload();
scanPages();
setInterval(scanPages, 1500);
