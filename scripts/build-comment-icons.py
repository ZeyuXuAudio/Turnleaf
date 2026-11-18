"""Regenerate the original outline comment glyphs; requires fonttools==4.60.1.

This is an authoring tool only. Packaging uses the checked-in WOFF asset.
U+E001 open thread, U+E002 resolved thread (check), U+E003 new comment (plus):
one rounded bubble, matching the sidebar's comment icon, so the three states
stay distinguishable in the gutter.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

root = Path(__file__).resolve().parent.parent
# Drawn on a 16-unit grid, y downwards; 64 font units per grid unit.
point = lambda x, y: (round(x * 64), round((14 - y) * 64))


def rounded(pen, x0, y0, x1, y1, r, clockwise, tail=None):
    """A rounded rectangle; `tail` (right, tip, left) hangs from the bottom edge."""
    if clockwise:
        ops = [('m', (x0 + r, y0)), ('l', (x1 - r, y0)), ('q', (x1, y0), (x1, y0 + r)), ('l', (x1, y1 - r)), ('q', (x1, y1), (x1 - r, y1))]
        ops += [('l', p) for p in tail or []]
        ops += [('l', (x0 + r, y1)), ('q', (x0, y1), (x0, y1 - r)), ('l', (x0, y0 + r)), ('q', (x0, y0), (x0 + r, y0))]
    else:
        ops = [('m', (x0 + r, y0)), ('q', (x0, y0), (x0, y0 + r)), ('l', (x0, y1 - r)), ('q', (x0, y1), (x0 + r, y1)),
               ('l', (x1 - r, y1)), ('q', (x1, y1), (x1, y1 - r)), ('l', (x1, y0 + r)), ('q', (x1, y0), (x1 - r, y0))]
    for op in ops:
        if op[0] == 'm': pen.moveTo(point(*op[1]))
        elif op[0] == 'l': pen.lineTo(point(*op[1]))
        else: pen.qCurveTo(point(*op[1]), point(*op[2]))
    pen.closePath()


def polygon(pen, points):
    pen.moveTo(point(*points[0]))
    for p in points[1:]: pen.lineTo(point(*p))
    pen.closePath()


def bubble(pen):
    rounded(pen, 1.5, 2, 14.5, 11.5, 2, True, tail=[(6.6, 11.5), (3.4, 14.5), (4.2, 11.5)])
    rounded(pen, 2.75, 3.25, 13.25, 10.25, 0.8, False)


glyphs = {}
for name, inner in [
    ('open', None),
    ('resolved', lambda pen: polygon(pen, [(5.0, 6.9), (5.9, 6.0), (7.2, 7.3), (10.1, 4.4), (11.0, 5.3), (7.2, 9.1)])),
    ('add', lambda pen: (polygon(pen, [(7.4, 4.25), (8.6, 4.25), (8.6, 9.25), (7.4, 9.25)]), polygon(pen, [(5.5, 6.15), (10.5, 6.15), (10.5, 7.35), (5.5, 7.35)]))),
]:
    pen = TTGlyphPen(None)
    bubble(pen)
    if inner: inner(pen)
    glyphs[name] = pen.glyph()

font = FontBuilder(1024, isTTF=True)
font.setupGlyphOrder(['.notdef', 'open', 'resolved', 'add'])
font.setupCharacterMap({0xE001: 'open', 0xE002: 'resolved', 0xE003: 'add'})
font.setupGlyf({'.notdef': TTGlyphPen(None).glyph(), **glyphs})
font.setupHorizontalMetrics({'.notdef': (1024, 0), **{name: (1024, 96) for name in glyphs}})
font.setupHorizontalHeader(ascent=896, descent=-128)
font.setupNameTable({'familyName': 'Turnleaf Outline', 'styleName': 'Regular',
                    'uniqueFontIdentifier': 'TurnleafOutline-2', 'fullName': 'Turnleaf Outline',
                    'psName': 'TurnleafOutline', 'version': 'Version 2.0'})
font.setupOS2(sTypoAscender=896, sTypoDescender=-128, usWinAscent=896, usWinDescent=128)
font.setupPost()
font.font['head'].created = font.font['head'].modified = 3876076800
font.font.recalcTimestamp = False
font.font.flavor = 'woff'
font.save(root / 'media/comment-outline.woff')
