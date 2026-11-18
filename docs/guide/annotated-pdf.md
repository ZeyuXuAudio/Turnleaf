# Annotated review PDF

Turnleaf can put the project's comments on your own compiled PDF, as highlights in the text and notes in the margin. This is useful for reading the review away from the editor, or for sharing it with someone who does not use Overleaf.

## Before you start

- A TeX distribution with the `synctex` command on your `PATH`. It is included with TeX Live and MacTeX.
- A PDF compiled from your **current** local source with SyncTeX enabled, for example:

  ```sh
  pdflatex -synctex=1 main.tex
  latexmk -pdf -synctex=1 main.tex
  ```

  Keep the `.synctex.gz` file next to the PDF.

Turnleaf does not compile your document. If the source changed since the PDF was compiled, recompile first, or comments may land in the wrong place.

## Export

1. Run **Turnleaf: Export Annotated Review PDF**.
2. Choose the compiled PDF. The file dialog opens in the `build/` folder of your workspace.
3. Turnleaf writes `build/<name>-review.pdf` and opens it.

For each comment thread in the selected files, Turnleaf asks SyncTeX where the commented line appears in the PDF, then looks for the commented text in the PDF's text layer nearby to place the highlight more exactly. Each thread gets:

- a yellow highlight on the commented text, unless its text is gone on Overleaf or its position is unknown (text you deleted locally may still be highlighted near its former place);
- a margin note with the thread's state (open or resolved), its local status, the file and line, and every message with author and time.

Threads that cannot be placed are listed in the **Turnleaf** output channel, and a warning tells you how many there were. If none can be placed, you get an error and no PDF is written.

## What it does not do

- It does not change your original PDF; choose the original, not the `-review.pdf` copy.
- It does not compile, run Git, or accept or reject suggestions.
- It sends nothing to Overleaf.
