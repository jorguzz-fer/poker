# Poker & Beer Confraria — relógio de torneio e gerenciador da liga

Aplicativo web de página única (HTML + CSS + JS, sem dependências) que recria e
amplia o antigo *Tournament Director's Poker Clock* (Adobe Flash, 2007).

## O que faz

- **Relógio de torneio**: níveis de blinds, ante, intervalos, tempo extra (O/T),
  sinais sonoros (um minuto antes, contagem final, troca de nível), barra de
  tempo, atalho `Espaço` para play/pause.
- **Torneios**: buy-in, re-buy, add-on, dinheiro extra, premiação por colocação
  (presets *Standard* e *Flat* do app original) e estrutura de blinds (presets
  *Standard*, *Standard Ante* e *Standard Low* do app original).
- **Partidas**: escolha de quem joga, dealer da rodada, registro de cada
  eliminação (quem caiu, quem derrubou, mão vencedora e cartas), fechamento com
  colocações, prêmios e pontos por jogador, mão final do campeão.
- **Pontuação** por torneio: pontos por colocação, por participação e por
  eliminação (bounty).
- **Histórico e ranking**: partidas salvas com detalhe, ranking acumulado por
  jogador, lista de mãos vencedoras.
- **Modo TV** (`#tv`): só o placar, para uma TV; o controle fica no celular.
- **Liga**: nome, lema e logo.

## Dados

Publicado como artefato no claude.ai, o app usa o banco compartilhado do
artefato (`db`): TV, celular e qualquer outro aparelho logado veem a mesma
partida em tempo real. O relógio é derivado de uma âncora de horário gravada a
cada ação, então nenhum aparelho precisa escrever a cada segundo.

Aberto direto no navegador (`index.html`), os dados ficam no `localStorage`
daquele navegador. Há exportação e importação em JSON nos dois modos.

## Estrutura

```
index.html          página pronta, abre direto no navegador
dist/artifact.html  mesmo conteúdo sem doctype/head (formato do Artifact)
src/
  head.html         title, meta e fontes
  app.css           estilos (tokens de tema claro/escuro)
  app.js            aplicação
  presets.js        presets de blinds e premiação extraídos do Flash
build.py            monta index.html e dist/artifact.html a partir de src/
tools/
  as2dis.py         desmontador de ActionScript 2 (bytecode SWF)
  as2eval.py        avaliador dos dados do SWF (presets, temas, textos)
docs/
  original-flash-config.json  configuração extraída do app original
```

## Build

```bash
python3 build.py
```

## Origem

Os presets, regras de pote e premiação e os tempos dos sinais sonoros foram
extraídos do bytecode ActionScript do executável original (`poker-clock.exe`,
um *projector* do Flash Player 9 com o SWF embutido) usando as ferramentas em
`tools/`.
