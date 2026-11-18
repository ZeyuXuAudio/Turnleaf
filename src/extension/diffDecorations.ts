import * as vscode from 'vscode';
import { diffText } from '../core/diff';

// Scope review colors to our immutable preview documents. Do not change the
// user's diffEditor settings or the colors of Git/other extensions' diffs.
export class ReviewDiffDecorations implements vscode.Disposable {
  private readonly addedLine = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('turnleaf.addedLineBackground') });
  private readonly removedLine = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('turnleaf.removedLineBackground') });
  private readonly addedText = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('turnleaf.addedTextBackground') });
  private readonly removedText = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('turnleaf.removedTextBackground') });
  // Comment changes, which the text diff cannot show, as notes at the end of their line.
  private readonly note = vscode.window.createTextEditorDecorationType({ after: { margin: '0 0 0 2.5em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' }, overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right });
  private readonly ranges = new Map<string, { kind: 'added' | 'removed'; spans: { start: number; end: number }[] }>();
  private readonly notes = new Map<string, { line: number; text: string }[]>();
  private readonly visible = vscode.window.onDidChangeVisibleTextEditors(() => this.paint());
  private readonly closed = vscode.workspace.onDidCloseTextDocument(doc => { this.ranges.delete(doc.uri.toString()); this.notes.delete(doc.uri.toString()); });
  /** `notes`: 1-based lines of the right side. */
  add(beforeUri: vscode.Uri, afterUri: vscode.Uri, before: string, after: string, notes: { line: number; text: string }[] = []): void {
    const removed: { start: number; end: number }[] = [], added: typeof removed = [];
    let left = 0, right = 0;
    for (const [kind, text] of diffText(before, after).diffs) {
      if (kind === -1) removed.push({ start: left, end: left + text.length });
      if (kind === 1) added.push({ start: right, end: right + text.length });
      if (kind !== 1) left += text.length;
      if (kind !== -1) right += text.length;
    }
    this.ranges.set(beforeUri.toString(), { kind: 'removed', spans: removed });
    this.ranges.set(afterUri.toString(), { kind: 'added', spans: added });
    this.notes.set(afterUri.toString(), notes);
    this.paint();
  }
  paint(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const entry = this.ranges.get(editor.document.uri.toString());
      if (!entry) continue;
      const ranges = entry.spans.map(s => new vscode.Range(editor.document.positionAt(s.start), editor.document.positionAt(s.end)));
      // A trailing newline belongs to the changed line, not the unchanged next line.
      const lines = entry.spans.map(s => new vscode.Range(editor.document.positionAt(s.start), editor.document.positionAt(Math.max(s.start, s.end - 1))));
      editor.setDecorations(entry.kind === 'added' ? this.addedLine : this.removedLine, lines);
      editor.setDecorations(entry.kind === 'added' ? this.addedText : this.removedText, ranges);
      const byLine = new Map<number, string[]>();
      for (const note of this.notes.get(editor.document.uri.toString()) ?? []) { const line = Math.min(note.line, editor.document.lineCount) - 1; byLine.set(line, [...byLine.get(line) ?? [], note.text]); }
      editor.setDecorations(this.note, [...byLine].map(([line, texts]) => ({ range: editor.document.lineAt(line).range.with({ start: editor.document.lineAt(line).range.end }), renderOptions: { after: { contentText: `💬 ${texts.join(' · ')}` } } })));
    }
  }
  clear(): void {
    for (const editor of vscode.window.visibleTextEditors) if (this.ranges.has(editor.document.uri.toString())) {
      for (const d of [this.addedLine, this.removedLine, this.addedText, this.removedText, this.note]) editor.setDecorations(d, []);
    }
    this.ranges.clear(); this.notes.clear();
  }
  dispose(): void {
    this.visible.dispose(); this.closed.dispose(); this.clear();
    for (const d of [this.addedLine, this.removedLine, this.addedText, this.removedText, this.note]) d.dispose();
  }
}
