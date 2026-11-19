import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScenes } from './demos/scenes.mjs';
import { renderWindowHtml, VIEWPORT } from './demos/vscodeChrome.mjs';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'media', 'demos');

function parseArgs(argv) {
  let sceneFilter = null;
  let themeFilter = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scene' && argv[i + 1]) sceneFilter = argv[++i];
    else if (argv[i] === '--theme' && argv[i + 1]) themeFilter = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/generate-demos.mjs [--scene <id>] [--theme <dark|light>]');
      process.exit(0);
    }
  }
  return { sceneFilter, themeFilter };
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Could not find Chrome/Chromium binary. Set CHROME_PATH env var.');
}

async function loadTurnleafPanelModules(tmpDir) {
  const bundlePath = path.join(tmpDir, 'turnleaf-ui-bundle.cjs');
  await build({
    stdin: {
      contents: [
        "export { projectContent } from './src/extension/panel.ts';",
        "export { panelStyle } from './src/extension/panelStyle.ts';",
        "export { historyStyle } from './src/extension/history.ts';",
        "export { icon, brandMark } from './src/extension/icons.ts';",
        "export * as text from './src/extension/syncText.ts';",
        "export { outgoingComments } from './src/core/folderWorkflow.ts';",
        "export { recordFor } from './src/core/reviewFiles.ts';",
        "export { diffText, changedLines } from './src/core/diff.ts';",
      ].join('\n'),
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    outfile: bundlePath,
  });
  return require(bundlePath);
}

function createCdpChrome(chromePath, userDataDir) {
  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-pipe',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );

  let buf = '';
  let nextId = 0;
  let stderr = '';
  const pending = new Map();

  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.stdio[4].on('data', (chunk) => {
    buf += chunk.toString();
    const parts = buf.split('\0');
    buf = parts.pop();
    for (const part of parts) {
      if (!part) continue;
      const msg = JSON.parse(part);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      proc.stdio[3].write(JSON.stringify(payload) + '\0');
    });

  const close = async () => {
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    try {
      await Promise.race([send('Browser.close'), new Promise((r) => setTimeout(r, 800))]);
    } catch {
      // Ignore if already shutting down
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, 1500);
    await exited;
    clearTimeout(timer);
  };

  return { proc, send, close, getStderr: () => stderr };
}

function roundFrameKey(frame) {
  return JSON.stringify({
    s: frame.stateIndex,
    c: `${frame.stepLabel}|${frame.caption}`,
    h: frame.hoverSelector ?? '',
    t: frame.typedText ?? null,
    k: !!frame.caretOn,
    f: !!frame.inputFocused,
    x: Number((frame.x ?? 0).toFixed(1)),
    y: Number((frame.y ?? 0).toFixed(1)),
    p: !!frame.pressing,
    ps: frame.pressSelector ?? '',
    fs: frame.flashSelector ?? '',
    fl: Number((frame.flash ?? 0).toFixed(2)),
    r: Number((frame.ripple ?? 0).toFixed(2)),
    rx: Number((frame.rippleX ?? 0).toFixed(1)),
    ry: Number((frame.rippleY ?? 0).toFixed(1)),
  });
}

async function evalChecked(send, sessionId, expression, opts = {}) {
  const res = await send('Runtime.evaluate', { expression, ...opts }, sessionId);
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'JS error';
    throw new Error(`Page JS error: ${desc}`);
  }
  return res;
}

async function renderSceneTheme({ send, scene, themeName, panelStyle, historyStyle, workDir }) {
  const framesDir = path.join(workDir, `${scene.id}-${themeName}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    const { frameTree } = await send('Page.getFrameTree', {}, sessionId);

    const html = renderWindowHtml({
      themeName,
      panelStyle,
      historyStyle,
      states: scene.states,
    });

    await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId);
    await evalChecked(send, sessionId,
      'new Promise(r => document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(r))))',
      { awaitPromise: true },
    );

    // Measure target selector coordinates per state so moving buttons keep exact coordinates.
    const anchorsByState = [];
    for (let s = 0; s < scene.states.length; s++) {
      await evalChecked(send, sessionId,
        `window.__applyFrame(${JSON.stringify({ stateIndex: s, x: -100, y: -100, stepLabel: '', caption: '', ripple: 0 })})`,
      );
      const { result } = await evalChecked(send, sessionId,
        `window.__measureTargets(${JSON.stringify(scene.targetSelectors)})`,
        { returnByValue: true },
      );
      const stateAnchors = {};
      for (const [sel, pt] of Object.entries(result.value || {})) {
        if (pt) stateAnchors[sel] = { x: pt.x, y: pt.y };
      }
      anchorsByState.push(stateAnchors);
    }

    const totalFrames = Math.round(scene.duration * scene.fps);
    let prevKey = null;
    let prevPngPath = null;
    let renderedCount = 0;

    for (let i = 0; i < totalFrames; i++) {
      const t = i / scene.fps;
      const frame = scene.timeline(t, anchorsByState);
      const key = roundFrameKey(frame);
      const pngPath = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`);

      if (key === prevKey && prevPngPath) {
        fs.linkSync(prevPngPath, pngPath);
        continue;
      }

      await evalChecked(send, sessionId,
        `new Promise(r => { window.__applyFrame(${JSON.stringify(frame)}); requestAnimationFrame(r); })`,
        { awaitPromise: true },
      );
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(pngPath, Buffer.from(data, 'base64'));
      prevKey = key;
      prevPngPath = pngPath;
      renderedCount++;
    }

    const palettePath = path.join(framesDir, 'palette.png');
    const outGif = path.join(outDir, `${scene.id}-${themeName}.gif`);
    const inputPattern = path.join(framesDir, 'frame_%04d.png');

    execFileSync('ffmpeg', [
      '-y',
      '-framerate', String(scene.fps),
      '-i', inputPattern,
      '-vf', 'palettegen=max_colors=256:stats_mode=diff:reserve_transparent=0',
      palettePath,
    ], { stdio: 'pipe' });

    execFileSync('ffmpeg', [
      '-y',
      '-framerate', String(scene.fps),
      '-i', inputPattern,
      '-i', palettePath,
      '-lavfi', 'paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      '-loop', '0',
      outGif,
    ], { stdio: 'pipe' });

    const bytes = fs.statSync(outGif).size;
    return {
      id: `${scene.id}-${themeName}`,
      path: outGif,
      totalFrames,
      renderedCount,
      sizeKb: (bytes / 1024).toFixed(1),
    };
  } finally {
    try { await send('Target.closeTarget', { targetId }); } catch { /* noop */ }
  }
}

async function main() {
  const { sceneFilter, themeFilter } = parseArgs(process.argv.slice(2));
  const chromePath = findChrome();
  fs.mkdirSync(outDir, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turnleaf-demos-'));
  const chromeUserDir = path.join(tmpDir, 'chrome-profile');
  fs.mkdirSync(chromeUserDir, { recursive: true });

  const ui = await loadTurnleafPanelModules(tmpDir);
  const { panelStyle, historyStyle } = ui;
  const allScenes = createScenes(ui);
  const scenes = sceneFilter ? allScenes.filter((s) => s.id === sceneFilter) : allScenes;
  if (!scenes.length) {
    throw new Error(`Unknown scene "${sceneFilter}". Available: ${allScenes.map((s) => s.id).join(', ')}`);
  }

  const themes = themeFilter ? [themeFilter] : ['dark', 'light'];
  for (const th of themes) {
    if (th !== 'dark' && th !== 'light') throw new Error(`Unknown theme "${th}". Expected dark or light.`);
  }

  const chrome = createCdpChrome(chromePath, chromeUserDir);
  const results = [];

  try {
    for (const scene of scenes) {
      for (const themeName of themes) {
        process.stdout.write(`Rendering ${scene.id}-${themeName}.gif ... `);
        const res = await renderSceneTheme({
          send: chrome.send,
          scene,
          themeName,
          panelStyle,
          historyStyle,
          workDir: tmpDir,
        });
        results.push(res);
        console.log(`${res.sizeKb} KB (${res.renderedCount}/${res.totalFrames} unique frames)`);
      }
    }
  } finally {
    await chrome.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  console.log('\nGenerated GIFs:');
  for (const r of results) {
    console.log(`- ${path.relative(repoRoot, r.path)} (${VIEWPORT.width}x${VIEWPORT.height}, ${r.totalFrames} frames, ${r.sizeKb} KB)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
