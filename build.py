#!/usr/bin/env python3
"""Monta a página a partir de src/.

Gera dois arquivos:
  index.html      página completa (doctype, head), abre direto no navegador
  dist/artifact.html  só o conteúdo (title + style + body), formato que o
                      Artifact do claude.ai espera ao publicar
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / 'src'

head = (SRC / 'head.html').read_text()
css = (SRC / 'app.css').read_text()
presets = (SRC / 'presets.js').read_text()
js = (SRC / 'app.js').read_text().replace('/*__PRESETS__*/', presets, 1)
assert 'const PRESETS=' in js, 'presets não foram injetados'

body = (head + '<style>\n' + css + '</style>\n\n<div id="app"></div>\n\n'
        '<script>\n' + js + '</script>\n')

(ROOT / 'dist').mkdir(exist_ok=True)
(ROOT / 'dist' / 'artifact.html').write_text(body)

standalone = ('<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n'
              '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
              '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
              'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n'
              '</head>\n<body>\n' + body + '</body>\n</html>\n')
(ROOT / 'index.html').write_text(standalone)
print('ok: index.html (%d bytes), dist/artifact.html (%d bytes)' % (len(standalone), len(body)))
