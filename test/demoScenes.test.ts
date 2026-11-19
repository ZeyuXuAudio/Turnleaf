// The scripted feature demos (scripts/demos, media/demos) must stay true to the
// extension: their text comes from the extension's code, and every control the
// demo cursor clicks must exist in the panel markup it renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'htmlparser2';
import { Element, isTag, NodeWithChildren } from 'domhandler';
import { projectContent } from '../src/extension/panel';
import * as text from '../src/extension/syncText';
import { outgoingComments } from '../src/core/folderWorkflow';
import { recordFor } from '../src/core/reviewFiles';
import { diffText, changedLines } from '../src/core/diff';

const root = join(__dirname, '..', '..');
// A real dynamic import: TypeScript's CommonJS output would turn import() into require().
const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
const loadScenes = async () => (await importModule(pathToFileURL(join(root, 'scripts', 'demos', 'scenes.mjs')).href)).createScenes({ projectContent, text, outgoingComments, recordFor, diffText, changedLines });

function elements(html: string): Element[] {
  const result: Element[] = [];
  const walk = (node: NodeWithChildren) => { for (const child of node.children) { if (isTag(child)) result.push(child); if ('children' in child) walk(child as NodeWithChildren); } };
  walk(parseDocument(html)); return result;
}
// The selector forms the demos use: tag, classes and [attr="value"], in one compound selector.
function matches(el: Element, selector: string): boolean {
  const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+="[^"]*"\])*)$/.exec(selector.replace(/^#turnleaf-sidebar /, ''));
  assert.ok(m, `unsupported demo selector ${selector}`);
  if (m[1] && el.name !== m[1]) return false;
  const classes = (el.attribs.class ?? '').split(/\s+/);
  if (m[2] && !m[2].split('.').filter(Boolean).every(c => classes.includes(c))) return false;
  for (const [, name, value] of m[3].matchAll(/\[([\w-]+)="([^"]*)"\]/g)) if (el.attribs[name] !== value) return false;
  return true;
}
const present = (html: string, selector: string) => elements(html).some(el => matches(el, selector));

test('every control the demo cursor clicks exists in the state where it is clicked', async () => {
  for (const scene of await loadScenes()) {
    // Stand-in measurements: a distinct point per selector, where it exists in that state's markup.
    const byState = scene.states.map((state: any) => Object.fromEntries(scene.targetSelectors.filter((sel: string) => present(state.sidebarHtml + state.editorHtml, sel)).map((sel: string) => [sel, { x: 100 + 40 * scene.targetSelectors.indexOf(sel), y: 100 + 30 * scene.targetSelectors.indexOf(sel) }])));
    const flashes = new Set<string>();
    for (let i = 0; i < Math.round(scene.duration * scene.fps); i++) {
      const frame = scene.timeline(i / scene.fps, byState);
      assert.ok(frame.stateIndex >= 0 && frame.stateIndex < scene.states.length, `${scene.id}: state ${frame.stateIndex}`);
      const state = scene.states[frame.stateIndex];
      for (const sel of [frame.hoverSelector, frame.pressSelector]) if (sel) assert.ok(present(state.sidebarHtml + state.editorHtml, sel), `${scene.id} at ${(i / scene.fps).toFixed(2)} s: ${sel} is not in state ${frame.stateIndex}`);
      if (frame.ripple > 0) assert.ok(Math.hypot(frame.x - frame.rippleX, frame.y - frame.rippleY) < 1, `${scene.id} at ${(i / scene.fps).toFixed(2)} s: the cursor leaves while its click ripple plays`);
      if (frame.flashSelector) { flashes.add(frame.flashSelector); assert.ok(present(state.sidebarHtml, frame.flashSelector), `${scene.id}: ${frame.flashSelector} is not in state ${frame.stateIndex}`); }
    }
  }
});

test('demo panel text comes from the extension, not from strings in the scene script', () => {
  const source = readFileSync(join(root, 'scripts', 'demos', 'scenes.mjs'), 'utf8');
  // The state line, status bar and outgoing rows are computed, never written out.
  // (A comment anchor's `state: 'placed'` is Overleaf data, not the state line.)
  assert.doesNotMatch(source.replace(/state: 'placed'/g, ''), /\bstate: ['"`]/);
  assert.doesNotMatch(source, /\bstatus(Text|Html): ['"`]/);
  assert.doesNotMatch(source, /\blabel: '(Reply|Resolve thread|Reopen thread|Delete message|Accept suggestion)'/);
  // The few words drawn outside the panel are the extension's own.
  const workspace = readFileSync(join(root, 'src', 'extension', 'workspace.ts'), 'utf8');
  const workflow = readFileSync(join(root, 'src', 'core', 'folderWorkflow.ts'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const titles = manifest.contributes.commands.map((c: { title: string }) => c.title);
  assert.match(source, /label: 'Updated thread'/); assert.match(workflow, /'Updated thread'/);
  assert.match(source, /'Pending send'/); assert.match(workspace, /label: 'Pending send'/);
  const chrome = readFileSync(join(root, 'scripts', 'demos', 'vscodeChrome.mjs'), 'utf8');
  for (const title of ['Resolve Thread on Send', 'Reply']) { assert.ok(titles.includes(title), title); assert.ok(chrome.includes(title), title); }
  assert.match(workspace, /createCommentController\('turnleaf-local'/);
  assert.match(readFileSync(join(root, 'src', 'extension', 'extension.ts'), 'utf8'), /createStatusBarItem\(vscode\.StatusBarAlignment\.Left/);
});

test('demo line counts and diff titles are the extension\'s', async () => {
  const scenes = await loadScenes();
  const merge = scenes.find((s: any) => s.id === 'get-latest').states[1];
  assert.ok(merge.tabsHtml.includes(text.diffTabTitle('sections/method.tex', 'merge')));
  const send = scenes.find((s: any) => s.id === 'send-and-undo');
  assert.ok(send.states[0].tabsHtml.includes(text.diffTabTitle('sections/method.tex', 'send')));
  assert.ok(send.states[3].tabsHtml.includes(text.diffTabTitle('sections/method.tex', 'undo')));
  assert.ok(send.states[2].sidebarHtml.includes(text.SENT_VERIFIED));
  assert.ok(send.states[5].sidebarHtml.includes(text.UNDO_SENT_VERIFIED));
});

test('every demo scene has a GIF in both themes', async () => {
  for (const scene of await loadScenes()) for (const theme of ['dark', 'light']) assert.ok(existsSync(join(root, 'media', 'demos', `${scene.id}-${theme}.gif`)), `${scene.id}-${theme}.gif`);
});
