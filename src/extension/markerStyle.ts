import * as vscode from 'vscode';

// The native gutter uses comment-unresolved for open threads and comment-add
// for resolved threads; the product icon theme maps the latter to a check.
const theme = 'turnleaf-outline';
const stateKey = 'turnleaf.previousMarkerStyle';
const initializedKey = 'turnleaf.markerStyleInitialized';
const colors = ['editorGutter.commentRangeForeground', 'editorGutter.commentGlyphForeground', 'editorGutter.commentUnresolvedGlyphForeground'];
type Target = 'workspace' | 'global';
type Saved = { theme?: string; colors: Record<string, string | undefined>; applied: Record<string, string>; };

// Native comment glyphs are host-owned. Enable the supported outline theme
// once per linked workspace, keeping the prior settings for Restore. A later
// user choice (including another theme) survives refreshes and restarts.
export function markerStyle(context: vscode.ExtensionContext) {
  const config = () => vscode.workspace.getConfiguration('workbench');
  const store = (target: Target) => target === 'global' ? context.globalState : context.workspaceState;
  const configTarget = (target: Target) => target === 'global' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
  const valueAt = <T>(key: string, target: Target) => { const inspected = config().inspect<T>(key); return target === 'global' ? inspected?.globalValue : inspected?.workspaceValue; };
  const active = (): Target | undefined => (['workspace', 'global'] as const).find(target => store(target).get<Saved>(stateKey) && valueAt<string>('productIconTheme', target) === theme);
  const enabled = () => {
    const target = active(), saved = target && store(target).get<Saved>(stateKey);
    const current = config().get<Record<string, string>>('colorCustomizations');
    return config().get('productIconTheme') === theme && !!saved && Object.entries(saved.applied).every(([key, value]) => current?.[key] === value);
  };
  async function restore(saved: Saved, target: Target): Promise<void> {
    const current = { ...valueAt<Record<string, unknown>>('colorCustomizations', target) };
    for (const key of colors) if (current[key] === saved.applied[key]) {
      if (saved.colors[key] === undefined) delete current[key]; else current[key] = saved.colors[key];
    }
    await config().update('colorCustomizations', Object.keys(current).length ? current : undefined, configTarget(target));
    if (valueAt('productIconTheme', target) === theme) await config().update('productIconTheme', saved.theme, configTarget(target));
    await store(target).update(stateKey, undefined);
  }
  async function apply(target: Target): Promise<void> {
    const previous = store(target).get<Saved>(stateKey);
    if (previous && valueAt('productIconTheme', target) === theme) {
      await config().update('colorCustomizations', { ...valueAt<Record<string, unknown>>('colorCustomizations', target), ...previous.applied }, configTarget(target));
      return;
    }
    const priorTheme = valueAt<string>('productIconTheme', target), existing = { ...valueAt<Record<string, string>>('colorCustomizations', target) };
    const light = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind);
    const applied = { [colors[0]]: '#00000000', [colors[1]]: light ? '#6A7F93' : '#8B9BB0', [colors[2]]: light ? '#0069A8' : '#79B8F2' };
    const saved: Saved = { theme: priorTheme, colors: Object.fromEntries(colors.map(key => [key, existing[key]])), applied };
    await store(target).update(stateKey, saved);
    try {
      await config().update('productIconTheme', theme, configTarget(target));
      await config().update('colorCustomizations', { ...existing, ...applied }, configTarget(target));
    } catch (error) { await restore(saved, target); throw error; }
  }
  let initializing: Promise<void> | undefined;
  return {
    enabled,
    async ensureForLinkedWorkspace(): Promise<void> {
      if (context.workspaceState.get<boolean>(initializedKey)) return;
      return initializing ??= (async () => {
        if (!enabled()) await apply('workspace');
        await context.workspaceState.update(initializedKey, true);
      })().finally(() => { initializing = undefined; });
    },
    async toggle(choice?: Target): Promise<void> {
      const current = active();
      if (current) {
        const saved = store(current).get<Saved>(stateKey)!;
        if (enabled()) await restore(saved, current);
        else await apply(current);
        await context.workspaceState.update(initializedKey, true);
        return;
      }
      let target = choice;
      if (!target) {
        const previous = config().get<string>('productIconTheme');
        const answer = await vscode.window.showInformationMessage('Use outline comment markers?', { modal: true,
          detail: `Replaces solid comment-gutter blocks with visible outline icons. Sets the product icon theme to “Turnleaf outline comments”${previous && previous !== 'Default' && previous !== theme ? `, replacing “${previous}”` : ''} and gives the markers a transparent background and contrasting colors. “This workspace” writes .vscode/settings.json. Turning it off in Project setup restores your previous settings.` },
          'This workspace', 'All workspaces');
        if (!answer) return;
        target = answer === 'All workspaces' ? 'global' : 'workspace';
      }
      await apply(target);
      await context.workspaceState.update(initializedKey, true);
    },
  };
}
