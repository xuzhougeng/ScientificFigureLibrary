#!/usr/bin/env python3
"""Rebuild the editable SFL SVG kit (v2). Uses only the Python standard library.

Usage:
    python source/build_svg.py
    python source/build_svg.py --palette palettes/cobalt.json --output ./recolored
All artwork is vector geometry; no images, font files, or external resources.

Geometry rules (512 grid), so that layers never collide by accident:
    * The mark is centred: bounding box 78..434 x 76..436.
    * Cards step by exactly STEP on both axes, with concentric top-left corners.
    * Rails have constant thickness RAIL_T and constant gap RAIL_GAP.
    * The secondary density stops 8 units clear of the primary flank.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import re
from pathlib import Path
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

SVG_NS = 'http://www.w3.org/2000/svg'
INK_NS = 'http://www.inkscape.org/namespaces/inkscape'
ET.register_namespace('', SVG_NS)
ET.register_namespace('inkscape', INK_NS)
ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')

# Front sheet and stack.
FX, FY, FW, FH = 146, 144, 288, 292
BLOCK_H, MODULE_W = 172, 194
TL, R, FILLET = 70, 38, 22
STEP = 34
# Rails of the open mark.
RAIL_T, RAIL_GAP = 30, 10
# Bars: (height) on a shared baseline; width and gap are constant.
BAR_W, BAR_GAP, BAR_R = 28, 14, 6
BAR_HEIGHTS = (34, 52, 76)
BAR_BOTTOM = 410

REQUIRED_KEYS = {
    'tile', 'tile_highlight', 'tile_shadow', 'ink', 'ink_highlight',
    'card_back', 'card_back_light', 'card_middle', 'card_middle_light',
    'paper', 'paper_highlight', 'paper_shadow', 'curve_secondary',
    'bar', 'bar_accent', 'bar_light', 'light_surface', 'dark_surface', 'reverse',
    'text', 'text_secondary', 'board_background', 'divider',
}


def f_sheet(x: float, y: float, w: float, h: float, block_h: float, module_w: float,
            tl: float, r: float, fillet: float) -> str:
    """F silhouette with a true concave fillet where the block meets the module."""
    right, bottom, block_b, mod_r = x+w, y+h, y+block_h, x+module_w
    return (f'M{x+tl:g} {y:g}H{right-r:g}A{r:g} {r:g} 0 0 1 {right:g} {y+r:g}'
            f'V{block_b-r:g}A{r:g} {r:g} 0 0 1 {right-r:g} {block_b:g}'
            f'H{mod_r+fillet:g}A{fillet:g} {fillet:g} 0 0 0 {mod_r:g} {block_b+fillet:g}'
            f'V{bottom-r:g}A{r:g} {r:g} 0 0 1 {mod_r-r:g} {bottom:g}'
            f'H{x+r:g}A{r:g} {r:g} 0 0 1 {x:g} {bottom-r:g}'
            f'V{y+tl:g}A{tl:g} {tl:g} 0 0 1 {x+tl:g} {y:g}Z')


def card_path(step: int) -> str:
    """Master sheet shifted back by `step` STEPs; the top-left corner stays concentric."""
    d = step*STEP
    return f_sheet(FX-d, FY-d, FW, FH, BLOCK_H, MODULE_W, TL+d, R, FILLET)


def rail(x: float, y: float, t: float, radius: float, end_x: float, end_y: float) -> str:
    """Constant-thickness L rail with round caps; (end_x, end_y) are the cap centres' axes."""
    cap, inner = t/2, radius-t
    return (f'M{x:g} {end_y:g}V{y+radius:g}A{radius:g} {radius:g} 0 0 1 {x+radius:g} {y:g}'
            f'H{end_x:g}A{cap:g} {cap:g} 0 0 1 {end_x:g} {y+t:g}H{x+radius:g}'
            f'A{inner:g} {inner:g} 0 0 0 {x+t:g} {y+radius:g}V{end_y:g}'
            f'A{cap:g} {cap:g} 0 0 1 {x:g} {end_y:g}Z')


# Rails share one arc centre, so the gap stays RAIL_GAP through the corner.
BACK_RAIL = rail(78, 76, RAIL_T, 106, 383, 385)
MID_RAIL = rail(78+RAIL_T+RAIL_GAP, 76+RAIL_T+RAIL_GAP, RAIL_T, 106-RAIL_T-RAIL_GAP, 419, 421)


def primary_curve(left: float, right: float, base: float=292, peak: float=176) -> str:
    """Density with a 4-unit pill baseline; tails meet it tangentially, with no blob."""
    sx = lambda u: f'{left+(right-left)*u:g}'
    top = base-4
    sy = lambda v: f'{top-(top-peak)*v:g}'
    return (f'M{sx(0)} {top:g}C{sx(.158)} {top:g} {sx(.263)} {sy(.16)} {sx(.351)} {sy(.448)}'
            f'C{sx(.43)} {sy(.72)} {sx(.491)} {sy(1)} {sx(.596)} {sy(1)}'
            f'C{sx(.701)} {sy(1)} {sx(.754)} {sy(.72)} {sx(.825)} {sy(.448)}'
            f'C{sx(.877)} {sy(.232)} {sx(.93)} {top:g} {sx(1)} {top:g}'
            f'A2 2 0 0 1 {sx(1)} {base:g}H{sx(0)}A2 2 0 0 1 {sx(0)} {top:g}Z')


PRIMARY_CARD = primary_curve(174, 406)
PRIMARY_OPEN = primary_curve(172, 432)
# Follows the primary's left flank at an 8-unit offset, so nothing is painted underneath it.
SECONDARY = ('M178 280C191 278 197 226 214 226C224 226 229 240 233 254'
             'C222 266 206 277 178 280Z')


def rr(x: float, y: float, w: float, h: float, r: float) -> str:
    """Rounded rectangle as a path, also usable as an even-odd knockout."""
    return (f'M{x+r:g} {y:g}H{x+w-r:g}A{r:g} {r:g} 0 0 1 {x+w:g} {y+r:g}'
            f'V{y+h-r:g}A{r:g} {r:g} 0 0 1 {x+w-r:g} {y+h:g}'
            f'H{x+r:g}A{r:g} {r:g} 0 0 1 {x:g} {y+h-r:g}'
            f'V{y+r:g}A{r:g} {r:g} 0 0 1 {x+r:g} {y:g}Z')


def layer(ident: str, label: str, content: str, **attrs: str) -> str:
    more = ''.join(f' {k}="{escape(str(v))}"' for k, v in attrs.items())
    return (f'<g id="{ident}" inkscape:groupmode="layer" '
            f'inkscape:label="{escape(label)}"{more}>{content}</g>')


def rect(ident: str, x: float, y: float, w: float, h: float,
         r: float, fill: str, **attrs: str) -> str:
    more = ''.join(f' {k}="{v}"' for k,v in attrs.items())
    return (f'<rect id="{ident}" x="{x:g}" y="{y:g}" width="{w:g}" '
            f'height="{h:g}" rx="{r:g}" fill="{fill}"{more}/>')


def path(ident: str, d: str, fill: str, **attrs: str) -> str:
    more = ''.join(f' {k}="{v}"' for k,v in attrs.items())
    return f'<path id="{ident}" d="{d}" fill="{fill}"{more}/>'


def grad(ident: str, a: str, b: str, vertical: bool=False) -> str:
    return (f'<linearGradient id="{ident}" x1="0%" y1="0%" '
            f'x2="{0 if vertical else 100}%" y2="100%">'
            f'<stop id="{ident}-start" offset="0" stop-color="{a}"/>'
            f'<stop id="{ident}-end" offset="1" stop-color="{b}"/>'
            '</linearGradient>')


def make_svg(title: str, desc: str, body: str, defs: str='',
             size: int=512, viewbox: str='0 0 512 512',
             width: int|None=None, height: int|None=None) -> str:
    w, h = width or size, height or size
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="{SVG_NS}" xmlns:inkscape="{INK_NS}" '
            f'width="{w}" height="{h}" viewBox="{viewbox}" '
            'version="1.1" role="img" aria-labelledby="title description">\n'
            f'<title id="title">{escape(title)}</title>\n'
            f'<desc id="description">{escape(desc)}</desc>\n'
            '<!-- SFL editable artwork. Change fills / gradient stops or edit palette.json and rebuild. -->\n'
            f'<defs>{defs}</defs>\n{body}\n</svg>\n')


def bar_slots(left: float, width: float) -> list[tuple[float, float, float]]:
    """(x, y, h) of the three bars, centred in the span [left, left+width]."""
    start = left+(width-3*BAR_W-2*BAR_GAP)/2
    return [(start+i*(BAR_W+BAR_GAP), BAR_BOTTOM-h, h) for i, h in enumerate(BAR_HEIGHTS)]


def bars(left: float, width: float, colors: tuple[str, str, str]) -> str:
    return ''.join(rect(f'bar-{i+1}', x, y, BAR_W, h, BAR_R, colors[i])
                   for i, (x, y, h) in enumerate(bar_slots(left, width)))


def card_mark(p: dict, dimensional: bool=False, secondary: bool=True) -> tuple[str,str]:
    defs = ''
    if dimensional:
        defs = (grad('card-back-gradient',p['card_back_light'],p['card_back'])+
                grad('card-middle-gradient',p['card_middle_light'],p['card_middle'])+
                grad('paper-gradient',p['paper_highlight'],p['paper'])+
                grad('curve-gradient',p['ink_highlight'],p['ink'],True))
    back = 'url(#card-back-gradient)' if dimensional else p['card_back']
    middle = 'url(#card-middle-gradient)' if dimensional else p['card_middle']
    paper = 'url(#paper-gradient)' if dimensional else p['paper']
    curve = 'url(#curve-gradient)' if dimensional else p['ink']
    chunks = [layer('layer-back','01 · Back card',path('back-card',card_path(2),back)),
              layer('layer-middle','02 · Middle card',path('middle-card',card_path(1),middle))]
    if dimensional:
        # Sits directly under the front sheet, so it falls on the cards and the tile.
        chunks.append(layer('layer-depth','03 · Optional vector depth',
                            path('front-shadow',card_path(0),p['tile_shadow'],transform='translate(0 6)'),
                            opacity='0.28'))
    chunks.append(layer('layer-front','04 · Front F-shaped figure sheet',path('front-sheet',card_path(0),paper)))
    if secondary:
        chunks.append(layer('layer-secondary','05 · Secondary density curve',path('density-secondary',SECONDARY,p['curve_secondary'])))
    chunks.append(layer('layer-primary','06 · Primary density curve',path('density-primary',PRIMARY_CARD,curve)))
    chunks.append(layer('layer-bars','07 · Three bars',bars(FX,MODULE_W,(p['bar'],p['bar'],p['bar_accent']))))
    return ''.join(chunks),defs


OPEN_MODULE = (170, 316, 170, 120, 28)


def open_mark(p: dict, style: str='color', ink: str|None=None) -> str:
    mono = style == 'mono'
    dark = style == 'dark'
    c = ink or p['ink']
    back = c if mono else p['card_back'] if dark else p['card_middle']
    middle = c if mono else p['card_middle'] if dark else p['card_back']
    curve = c if mono else p['paper_highlight'] if dark else p['ink']
    mx, my, mw, mh, mr = OPEN_MODULE
    chunks = [layer('layer-back','01 · Back library rail',path('back-rail',BACK_RAIL,back)),
              layer('layer-middle','02 · Front library rail',path('middle-rail',MID_RAIL,middle)),
              layer('layer-primary','03 · Density curve',path('density-primary',PRIMARY_OPEN,curve))]
    if mono:
        knockout = rr(mx,my,mw,mh,mr)
        knockout += ''.join(rr(x,y,BAR_W,h,BAR_R) for x,y,h in bar_slots(mx,mw))
        chunks.append(layer('layer-bars','04 · Bar module / true transparent knockouts',
                            path('bar-module-knockouts',knockout,c,**{'fill-rule':'evenodd'})))
    else:
        chunks.append(layer('layer-module','04 · Bar module',
                            rect('bar-module',mx,my,mw,mh,mr,p['paper'] if dark else p['ink'])))
        colors = (p['bar'],p['bar'],p['bar_accent']) if dark else (p['bar_light'],p['bar_light'],p['bar_accent'])
        chunks.append(layer('layer-bars','05 · Three bars',bars(mx,mw,colors)))
    return ''.join(chunks)


def tile(p: dict, fill: str|None=None, square: bool=False) -> str:
    return layer('layer-background','00 · App background',
                 rect('background-tile',0,0,512,512,0 if square else 124,fill or p['tile']))


def small_mark(p: dict, size: int) -> str:
    """Optical sizes are drawn on their own pixel grid; they are not scaled masters."""
    if size == 64:
        mark,_ = card_mark(p,False,True)
        body = tile(p)+mark
        return make_svg('SFL · 64 px', '64 px version; full double-density motif, flat colors.',body,size=64)
    accent = (p['bar'],p['bar'],p['bar_accent'])
    if size == 32:
        sheet = lambda x, tl: f_sheet(x,x,18,18,11,12,tl,2,1.5)
        curve = ('M10.5 18C13 18 14.2 16.6 15.4 14.8C16.6 13 17.4 11.5 19 11.5'
                 'C20.6 11.5 21.4 13 22.4 14.8C23.4 16.6 24 18 25.5 18V19H10.5Z')
        cards = ((5,8),(7,6),(9,4)); slots = [(11,23),(14,22),(17,21)]; bar_w, bar_b, corner = 2, 25, 8
    elif size == 24:
        sheet = lambda x, tl: f_sheet(x,x,14,14,8,10,tl,1.5,1.2)
        curve = ('M8 13C9.8 13 10.8 12 11.6 10.8C12.6 9.3 13.2 8.5 14.4 8.5'
                 'C15.6 8.5 16.2 9.3 17.2 10.8C18 12 18.8 13 20 13V14H8Z')
        cards = ((3,7),(5,5),(7,3)); slots = [(8,18),(11,17),(14,16)]; bar_w, bar_b, corner = 2, 20, 6
    elif size == 16:
        sheet = lambda x, tl: f_sheet(x,x,10,10,5,7,tl,1,.8)
        curve = ('M5 8C6.2 8 6.8 7.2 7.6 6.2C8.2 5.4 8.7 5 9.4 5'
                 'C10.1 5 10.6 5.4 11.2 6.2C11.9 7.2 12.2 8 13 8Z')
        cards = ((2,4),(4,2)); slots = [(5,12),(7,11),(9,10)]; bar_w, bar_b, corner = 1, 13, 4
    else:
        raise ValueError(f'Unsupported optical size: {size}')
    body = layer('layer-background','00 · App background',rect('background-tile',0,0,size,size,corner,p['tile']))
    if len(cards) == 3:
        body += layer('layer-back','01 · Back card',path('back-card',sheet(*cards[0]),p['card_back']))
        body += layer('layer-middle','02 · Middle card',path('middle-card',sheet(*cards[1]),p['card_middle']))
    else:
        body += layer('layer-back','01 · Single rear card',path('back-card',sheet(*cards[0]),p['card_middle']))
    body += layer('layer-front','03 · Front F-shaped sheet',path('front-sheet',sheet(*cards[-1]),p['paper']))
    body += layer('layer-primary','04 · Simplified density',path('density-primary',curve,p['ink']))
    body += layer('layer-bars','05 · Pixel-aligned bars',''.join(
        rect(f'bar-{i+1}',x,y,bar_w,bar_b-y,bar_w*.2,accent[i]) for i,(x,y) in enumerate(slots)))
    note = 'Two cards, one curve, three micro bars.' if size == 16 else 'Three cards, one curve, three bars; secondary density removed.'
    return make_svg(f'SFL · {size} px',f'{size} px optical size on its own pixel grid. {note}',body,size=size,
                    viewbox=f'0 0 {size} {size}')


def inline_copy(svg_text: str, ident: str, x: float, y: float,
                w: float, h: float) -> str:
    """Embed actual editable vector children, with collision-free IDs."""
    root = ET.fromstring(svg_text)
    for el in root.iter():
        if 'id' in el.attrib:
            el.attrib['id'] = ident+'-'+el.attrib['id']
        for k,v in list(el.attrib.items()):
            v = re.sub(r'url\(#([^\)]+)\)',lambda m:f'url(#{ident}-{m.group(1)})',v)
            if k in ('aria-labelledby','aria-describedby'):
                v = ' '.join(ident+'-'+item for item in v.split())
            el.attrib[k] = v
    root.set('x',str(x)); root.set('y',str(y))
    root.set('width',str(w)); root.set('height',str(h))
    return ET.tostring(root,encoding='unicode')


def text(x: float,y: float,content: str,size: float,fill: str,weight: int=400,**attrs: str) -> str:
    more = ''.join(f' {k}="{v}"' for k,v in attrs.items())
    return (f'<text x="{x:g}" y="{y:g}" font-family="Arial, Helvetica, sans-serif" '
            f'font-size="{size:g}" font-weight="{weight}" fill="{fill}"{more}>{escape(content)}</text>')


def check_svg(fp: Path, rel: str) -> dict:
    """Static checks only. Rendering is checked separately; see README."""
    raw = fp.read_text(encoding='utf-8')
    root = ET.fromstring(raw)
    ids = [el.attrib['id'] for el in root.iter() if 'id' in el.attrib]
    refs = set(re.findall(r'url\(#([^\)]+)\)',raw))
    tags = {el.tag.rsplit('}',1)[-1] for el in root.iter()}
    return {'file':rel,'xml_valid':True,'unique_ids':len(ids)==len(set(ids)),
            'local_references_valid':refs<=set(ids),
            'vector_only':not tags&{'image','script','foreignObject','style'} and 'http://' not in raw.replace(SVG_NS,'').replace(INK_NS,'').replace('http://www.w3.org/1999/xlink','')}


def write_all(p: dict, output: Path) -> list[dict]:
    svgdir = output/'svg'; svgdir.mkdir(parents=True,exist_ok=True)
    variants: dict[str,tuple[str,str]] = {}
    def add(name: str,label: str,svg: str) -> None:
        variants[name]=(label,svg)
    mark,defs = card_mark(p,True)
    defs = grad('background-gradient',p['tile_highlight'],p['tile_shadow'])+defs
    add('01-app-primary.svg','主图标 / 轻层次',make_svg('SFL · Primary app icon',
        'Editable layered F-shaped scientific figure library icon. Each component is an independent named layer.',
        tile(p,'url(#background-gradient)')+mark,defs))
    flat,_ = card_mark(p,False)
    add('02-app-flat.svg','主图标 / 纯色易改',make_svg('SFL · Flat app icon','Flat-color master for convenient manual recoloring.',tile(p)+flat))
    add('03-app-light.svg','浅色底图标',make_svg('SFL · Light app icon','Flat artwork on a light surface.',tile(p,p['light_surface'])+flat))
    add('04-app-dark.svg','深色底开放式图标',make_svg('SFL · Dark app icon','Open library-rail mark on a dark background.',tile(p,p['dark_surface'])+open_mark(p,'dark')))
    add('05-brandmark-paper.svg','透明底 / 卡片标志',make_svg('SFL · Paper brand mark','No app tile; layered figure-sheet mark with transparent surrounding canvas.',flat))
    add('06-brandmark-open.svg','透明底 / 开放式品牌标志',make_svg('SFL · Open brand mark','Two library rails, a density curve, and a bar module; transparent background.',open_mark(p)))
    add('07-brandmark-monochrome.svg','单色深色 / 真透明镂空',make_svg('SFL · Monochrome brand mark','A single ink with genuinely transparent bar knockouts, not white overpainting.',open_mark(p,'mono',p['ink'])))
    add('08-brandmark-reverse.svg','反白 / 真透明镂空',make_svg('SFL · Reverse brand mark','White artwork for dark surfaces; transparent background and cutouts.',open_mark(p,'mono',p['reverse'])))
    add('09-brandmark-currentcolor.svg','主题色 / currentColor',make_svg('SFL · currentColor brand mark','Uses currentColor. When inline in HTML, inherits the surrounding CSS color. External img does not inherit host-page color.',open_mark(p,'mono','currentColor')))
    for n,num in [(64,10),(32,11),(24,12),(16,13)]:
        add(f'{num:02d}-icon-{n}.svg',f'{n} px / 小尺寸版本',small_mark(p,n))
    add('14-app-square-source.svg','全方形底 / 平台转换源',make_svg('SFL · Unmasked square source','Full square background for downstream export. No platform packaging or system validation implied.',tile(p,square=True)+flat))
    add('15-app-inset-source.svg','加留白方形底 / 裁切准备',make_svg('SFL · Inset square source','Same mark at 80 percent scale about canvas center; extra space for host cropping, not a platform certification.',tile(p,square=True)+f'<g id="inset-mark" transform="translate(51.2 51.2) scale(0.8)">{flat}</g>'))
    for rev,num in [(False,16),(True,17)]:
        color = p['reverse'] if rev else p['ink']
        sub = p['paper_shadow'] if rev else p['text_secondary']
        mark_svg=make_svg('SFL mark','',open_mark(p,'mono',color))
        body = inline_copy(mark_svg,'wordmark-symbol',0,0,190,190)
        body += layer('layer-wordmark','05 · Editable wordmark text',
            text(210,95,'SFL',66,color,700)+text(212,137,'Scientific Figure Library',29,sub,400))
        suffix='reverse' if rev else 'dark'
        add(f'{num:02d}-wordmark-{suffix}.svg', '横版组合 / '+('反白' if rev else '深色'),
            make_svg(f'SFL · Horizontal wordmark {suffix}',
                     'Editable text uses system sans-serif fonts; no font files are embedded. Convert text to outlines in your editor after selecting your own font.',
                     body,viewbox='0 0 720 190',width=720,height=190))
    # A solid-ink optical-size symbol for compact interfaces; rails and bars sit on whole pixels.
    micro_curve = 'M5 10C6.4 10 7.2 9 8.1 7.7C9 6.3 9.6 5 10.6 5C11.6 5 12.1 6.3 12.9 7.7C13.6 9 14 10 15 10Z'
    micro = (path('back-rail',rail(1,1,1,4,10.5,10.5),p['ink'])+
             path('middle-rail',rail(3,3,1,2,14.5,14.5),p['ink'])+
             path('density',micro_curve,p['ink'])+
             ''.join(rect(f'bar-{i+1}',x,y,2,15-y,.35,p['ink']) for i,(x,y) in enumerate([(6,13),(9,12),(12,11)])))
    add('18-symbol-16-monochrome.svg','16 px / 单色紧凑标志',make_svg('SFL · 16 px solid symbol','Single-ink micro symbol with separate bars; no outer tile.',layer('layer-symbol','Micro symbol',micro),size=16,viewbox='0 0 16 16'))
    for name,(_,svg) in variants.items():
        # Pretty XML supports hand editing without changing vector values.
        root=ET.fromstring(svg)
        ET.indent(root,space='  ')
        data=ET.tostring(root,encoding='unicode',xml_declaration=False)
        (svgdir/name).write_text('<?xml version="1.0" encoding="UTF-8"?>\n'+data+'\n',encoding='utf-8',newline='\n')
    # Editable vector overview, not a raster pasted into SVG.
    bg = p['board_background']; fg=p['text']; muted=p['text_secondary']
    b = rect('board-canvas',0,0,1600,1120,0,bg)
    b += text(64,82,'SFL',62,fg,700)
    b += f'<path d="M213 38V100" stroke="{p["bar"]}" stroke-width="3"/>'
    b += text(248,70,'Scientific Figure Library',38,fg,700)
    b += text(250,101,'EDITABLE VECTOR SYSTEM  /  APPROVED FORM, FLEXIBLE COLOR',13,muted,400,**{'letter-spacing':'1.5'})
    b += inline_copy(variants['01-app-primary.svg'][1],'hero',64,160,500,500)
    b += text(64,702,'01  PRIMARY',16,fg,700)
    b += text(64,730,'Layered F / density curves / three bars',17,muted)
    samples=[('02-app-flat.svg','02  FLAT',638,160),('06-brandmark-open.svg','06  OPEN MARK',942,160),('04-app-dark.svg','04  DARK',1246,160),
             ('03-app-light.svg','03  LIGHT',638,465),('07-brandmark-monochrome.svg','07  MONO',942,465),('08-brandmark-reverse.svg','08  REVERSE',1246,465)]
    for file,label,x,y in samples:
        if file=='08-brandmark-reverse.svg':
            b+=rect('reverse-preview-bg',x,y,240,240,36,p['dark_surface'])
        b+=inline_copy(variants[file][1],f'preview-{file[:2]}',x,y,240,240)
        b+=text(x,y+270,label,15,fg,700)
    b+=f'<path d="M64 790H1536" stroke="{p["divider"]}" stroke-width="1.5"/>'
    b+=text(64,838,'OPTICAL SIZES',17,fg,700)
    b+=text(64,864,'Shown at actual SVG pixel dimensions on this 1600 px board.',15,muted)
    xx=64
    for n,num in [(64,10),(32,11),(24,12),(16,13)]:
        b+=inline_copy(variants[f'{num:02d}-icon-{n}.svg'][1],f'native-{n}',xx,900+64-n,n,n)
        b+=text(xx,998,f'{n} px',14,fg)
        xx+=110
    b+=text(638,838,'SHARED GEOMETRY',17,fg,700)
    b+=text(638,869,'Cards, curves and bars remain separate editable layers.',15,muted)
    b+=text(638,895,'Flat masters contain direct fills; gradients are optional.',15,muted)
    swatches=[('tile','Tile'),('card_back','Back card'),('card_middle','Middle card'),('ink','Ink'),('bar_accent','Accent')]
    for i,(key,label) in enumerate(swatches):
        sx=638+i*166
        b+=rect(f'swatch-{key}',sx,932,140,38,8,p[key])
        b+=text(sx,993,label,14,fg,700)+text(sx,1015,p[key],13,muted)
    b+=text(64,1080,'SFL / SVG KIT v2     ·     Colors are editable; change palette.json and rebuild.',14,muted)
    board=make_svg('SFL · Editable SVG overview','Every icon in this sheet is editable vector geometry. Native-size studies are true pixel dimensions, not enlarged labels.',b,width=1600,height=1120,viewbox='0 0 1600 1120')
    root=ET.fromstring(board); ET.indent(root,space='  ')
    (output/'00-overview.svg').write_text('<?xml version="1.0" encoding="UTF-8"?>\n'+ET.tostring(root,encoding='unicode')+'\n',encoding='utf-8',newline='\n')
    records=[]
    for filename,(label,_) in variants.items():
        fp=svgdir/filename
        records.append({'file':f'svg/{filename}','label_zh':label,'sha256':hashlib.sha256(fp.read_bytes()).hexdigest()})
    (output/'manifest.json').write_text(json.dumps({'kit':'SFL editable SVG kit','version':'2.0','icons':records,'overview':'00-overview.svg'},ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    # Gallery page: references the SVG files, so it can never go stale after a rebuild.
    cards=''.join(f'<figure><a href="{r["file"]}"><img src="{r["file"]}" alt="{escape(r["label_zh"])}"></a><figcaption>{escape(Path(r["file"]).name)}<br><small>{escape(r["label_zh"])}</small></figcaption></figure>' for r in records)
    (output/'index.html').write_text(f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SFL · 可编辑 SVG 套件 v2</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:{bg};color:{fg};font:15px/1.6 system-ui,sans-serif}}main{{max-width:1240px;margin:auto;padding:32px 20px 60px}}h1{{font-size:30px;margin:0 0 10px}}a{{color:inherit}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px;margin-top:24px}}figure{{margin:0}}figure>a{{display:flex;height:190px;align-items:center;justify-content:center;border-radius:10px;background:repeating-conic-gradient(#e7e9e4 0 25%,#f7f8f4 0 50%) 0 0/20px 20px}}
figure img{{max-width:150px;max-height:150px}}figcaption{{margin-top:6px;font-size:13px}}small{{color:{muted}}}</style></head><body><main><h1>SFL · 可编辑 SVG 套件 v2</h1><p><a href="00-overview.svg">打开矢量总览</a> · <a href="README_中文.md">中文说明</a> · <a href="palette.json">配色表</a></p><div class="grid">{cards}</div></main></body></html>
''',encoding='utf-8',newline='\n')
    checks=[check_svg(svgdir/Path(r['file']).name,r['file']) for r in records]+[check_svg(output/'00-overview.svg','00-overview.svg')]
    single_ink=[]
    for name in ('07-brandmark-monochrome.svg','08-brandmark-reverse.svg','09-brandmark-currentcolor.svg','18-symbol-16-monochrome.svg'):
        fills={el.attrib['fill'] for el in ET.fromstring((svgdir/name).read_text(encoding='utf-8')).iter() if 'fill' in el.attrib}
        single_ink.append(len(fills)==1)
    report={'svg_count':len(checks),'independent_icon_count':len(records),'checks':checks,
            'single_ink_checks_passed':all(single_ink),
            'all_checks_passed':all(single_ink) and all(c['unique_ids'] and c['local_references_valid'] and c['vector_only'] for c in checks)}
    (output/'validation-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    return records


def main() -> None:
    root=Path(__file__).resolve().parent.parent
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--palette',type=Path,default=root/'palette.json')
    ap.add_argument('--output',type=Path,default=root)
    args=ap.parse_args()
    with args.palette.open(encoding='utf-8') as fh:
        palette=json.load(fh)
    missing=REQUIRED_KEYS-palette.keys()
    if missing:
        raise ValueError(f'Palette is missing keys: {sorted(missing)}')
    for key,value in palette.items():
        if not isinstance(value,str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',value):
            raise ValueError(f'Invalid hex color for {key}: {value!r}')
    records=write_all(palette,args.output)
    print(f'Wrote {len(records)} icon SVGs + one editable overview to {args.output}')

if __name__=='__main__':
    main()
