#!/usr/bin/env python3
"""Converte a aba "Pontuação Geral" da planilha da Confraria em um arquivo de
importação do app (Exportar / importar -> escolher arquivo .json).

Entrada: JSON com {"year": 2026, "values": [...]} onde values é o intervalo
'Pontuação Geral'!A1:AT40 como a API do Google Sheets devolve (lista de linhas).

Layout esperado da aba:
  linha 4  "Rodada N" nas colunas D, F, H, ...
  linha 5  data da rodada ("7-mar.")
  linha 6  nome abaixo da data (anfitrião/dealer da rodada)
  a partir da linha 8, blocos de 3 linhas por confrade:
    linha do confrade: B=nome, C=total; em cada rodada, pontos da colocação e
                       colocação ("3º" ou "A" = ausente)
    linha seguinte:    quem eliminou (3 letras, ex.: "PAU")
  pontuação do app por rodada = pontos da colocação + 1 por eliminação (hit)

Uso: python3 tools/import_planilha.py entrada.json saida.json
"""
import json
import re
import sys
import unicodedata

MONTHS = {'jan': 1, 'fev': 2, 'mar': 3, 'abr': 4, 'mai': 5, 'jun': 6,
          'jul': 7, 'ago': 8, 'set': 9, 'out': 10, 'nov': 11, 'dez': 12}

# nomes como estão no app (a planilha usa caixa alta, sem acento)
DISPLAY = {'ROMULO': 'Rômulo'}

SCORING = {'pos': [12, 10, 8, 7, 6, 5, 4, 3, 2, 0], 'base': 0, 'ko': 1}


def strip(s):
    return unicodedata.normalize('NFD', s or '').encode('ascii', 'ignore').decode().upper().strip()


def nice(name):
    k = strip(name)
    return DISPLAY.get(k, name.strip().title())


def cell(row, i):
    return row[i].strip() if i < len(row) and row[i] is not None else ''


def main(src, dst):
    data = json.load(open(src, encoding='utf-8'))
    year, v = int(data['year']), data['values']
    head_round, head_date, head_host = v[3], v[4], v[5]
    cols = [i for i in range(len(head_round)) if re.match(r'Rodada \d+', cell(head_round, i))]

    players = []  # (name, row_pts, row_ko)
    for r in range(7, len(v)):
        name = cell(v[r], 1)
        if name and name.upper() not in ('AUSENCIAS', 'AUSÊNCIAS') and r + 1 < len(v):
            players.append((nice(name), v[r], v[r + 1]))
    pid = {p[0]: 'pl-' + strip(p[0]).lower() for p in players}
    by_abbr = {strip(p[0])[:3]: p[0] for p in players}

    games = []
    for j, c in enumerate(cols, start=1):
        m = re.match(r'(\d{1,2})-([a-zç]{3})', cell(head_date, c).lower())
        if not m:
            continue
        date = '%04d-%02d-%02d' % (year, MONTHS[m.group(2)], int(m.group(1)))
        results = []
        for name, rp, rk in players:
            pos_txt = cell(rp, c + 1)
            pm = re.match(r'(\d+)', pos_txt)
            if not pm:
                continue  # "A" = ausente, vazio = rodada não jogada
            ko = by_abbr.get(strip(cell(rk, c))[:3]) if cell(rk, c) else None
            results.append({'pid': pid[name], 'name': name, 'pos': int(pm.group(1)),
                            'koBy': pid[ko] if ko else None, 'rank': '', 'cards': '',
                            'prize': 0, 'base': int(cell(rp, c) or 0)})
        if not results:
            continue
        for r in results:
            hits = sum(1 for x in results if x['koBy'] == r['pid'])
            r['points'] = r.pop('base') + hits
        host = cell(head_host, c)
        games.append({'id': 'hist-%d-r%02d' % (year, j), 'date': date, 'tid': 'tpl-regular',
                      'tournamentName': 'Rodada regular', 'currency': 'R$',
                      'dealer': nice(host) if host else '', 'entries': len(results),
                      'reBuys': None, 'addOns': None, 'total': 0, 'levels': 0, 'time': 0,
                      'scoring': SCORING, 'prizeTable': [], 'results': results,
                      'finalHand': {'rank': '', 'cards': ''}, 'imported': 'planilha',
                      'savedAt': 0})

    out = {'players': [{'id': pid[n], 'name': n} for n, _, _ in players],
           'tournaments': data.get('tournaments', []), 'games': games}
    json.dump(out, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('%d jogadores, %d rodadas -> %s' % (len(players), len(games), dst))
    return out


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
