#!/usr/bin/env python3
"""Extrae capas de las plantillas `measured` de React-Advanced-Odontogram (MIT, © Zoltán Dul; ver
apps/admin/THIRD-PARTY-NOTICES.md) y genera apps/admin/src/pages/odontogram/teeth-data.ts.

Cada plantilla (vista lateral `NN.svg` y vista oclusal `NN_occl.svg`) se reduce a una lista ORDENADA de capas con
nombre propio (base, tooth, pulp, caries-mesial, fill-occlusal, crown, implant…). El panel decide qué capas dibuja
según el odontograma; aquí solo se conservan las que usamos y se les quita `display:none`.

Uso: extract_teeth.py <carpeta con 11.svg … 75.svg y NN_occl.svg> <salida.ts>
"""
import json, re, sys
from pathlib import Path
from xml.etree import ElementTree as ET

NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)

# (nombre de capa, id del elemento en la plantilla, hijos|self). Orden = orden de dibujo.
SIDE = [
    ('base', ['bone-base', 'gum-base']),
    ('tooth', ['tooth-base', 'tooth-base-beauty']),
    ('absent', ['no-tooth-after-extraction']),
    ('unerupted', ['tooth-under-gum']),
    ('radix', ['tooth-radix']),
    ('broken-incisal', ['tooth-broken-incisal']),
    ('broken-mesial-distal-incisal', ['tooth-broken-mesial-distal-incisal']),
    ('broken-mesial-distal', ['tooth-broken-mesial-distal']),
    ('broken-mesial-incisal', ['tooth-broken-mesial-incisal']),
    ('broken-mesial', ['tooth-broken-mesial']),
    ('broken-distal-incisal', ['tooth-broken-distal-incisal']),
    ('broken-distal', ['tooth-broken-distal']),
    ('pulp', ['tooth-healthy-pulp']),
    ('endo', ['endo-filling']),
    ('caries-mesial', ['caries-mesial']),
    ('caries-distal', ['caries-distal']),
    ('caries-occlusal', ['caries-occlusal']),
    ('caries-buccal', ['caries-buccal']),
    ('fill-mesial', ['filling-composite-mesial']),
    ('fill-distal', ['filling-composite-distal']),
    ('fill-occlusal', ['filling-composite-occlusal']),
    ('fill-buccal', ['filling-composite-buccal']),
    ('sealant', ['fissure-sealing-occlusal']),
    ('fracture', ['fracture-vertical']),
    ('crown', ['metal-ceramic-crown']),
    ('prosthesis', ['prosthesis-crown']),
    ('implant', ['implant']),
]
OCCL = [
    ('base', ['bone-base', 'gum-base']),
    ('absent', []),
    ('tooth', ['tooth-base']),
    ('caries-mesial', ['caries-mesial']),
    ('caries-distal', ['caries-distal']),
    ('caries-occlusal', ['caries-occlusal']),
    ('fill-mesial', ['filling-composite-mesial']),
    ('fill-distal', ['filling-composite-distal']),
    ('fill-occlusal', ['filling-composite-occlusal']),
    ('fill-buccal', ['filling-composite-buccal']),
    ('fill-lingual', ['filling-composite-lingual']),
    ('sealant', ['fissure-sealing-occlusal']),
    ('crown', ['metal-ceramic-crown']),
    ('implant', ['implant']),
]

src, out = Path(sys.argv[1]), Path(sys.argv[2])


def find(root, i):
    return next((e for e in root.iter() if e.get('id') == i), None)


def clean(e):
    for x in e.iter():
        for a in [a for a in x.attrib if a.startswith('data-') or a == 'id']:
            del x.attrib[a]
        st = x.get('style')
        if st:
            st = re.sub(r'display:\s*none;?\s*', '', st).strip()
            if st:
                x.set('style', st)
            else:
                del x.attrib['style']
    return re.sub(r' xmlns(:\w+)?="[^"]*"', '', ET.tostring(e, encoding='unicode'))


data = {}
for f in sorted(src.glob('*.svg')):
    root = ET.parse(f).getroot()
    spec = OCCL if f.stem.endswith('_occl') else SIDE
    layers = {}
    for name, ids in spec:
        xml = ''
        for i in ids:
            e = find(root, i)
            if e is not None:
                xml += clean(e)
        if xml:
            layers[name] = xml
    used = set(re.findall(r'url\(#([^)]+)\)', ''.join(layers.values())))
    defs = ''
    for d in root.iter('{%s}defs' % NS):
        for c in d:
            if c.get('id') in used:
                defs += re.sub(r' xmlns(:\w+)?="[^"]*"', '', ET.tostring(c, encoding='unicode'))
    data[f.stem] = {'viewBox': root.get('viewBox'), 'defs': defs, 'layers': layers}

js = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
out.write_text(
    '// GENERADO por tools/teeth/extract_teeth.py a partir de React-Advanced-Odontogram (MIT, © Zoltán Dul). No editar a mano.\n'
    'export interface ToothTemplate { viewBox: string; defs: string; layers: Partial<Record<string, string>> }\n'
    f'export const TOOTH_TEMPLATES: Record<string, ToothTemplate> = {js};\n'
)
print({k: len(v['defs']) + sum(map(len, v['layers'].values())) for k, v in data.items()})
print(out.stat().st_size, 'bytes')
