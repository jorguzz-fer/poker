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

A página detecta onde está rodando e escolhe o armazenamento:

1. **Servidor próprio** (`server.js`, este repositório em Docker): banco
   SQLite em `DATA_DIR/poker.sqlite` e eventos em tempo real (SSE). TV,
   celular e qualquer aparelho que abra o endereço veem a mesma partida.
2. **Artefato no claude.ai**: banco compartilhado do artefato (`db`).
3. **Arquivo aberto direto no navegador**: `localStorage` daquele navegador.

O relógio é derivado de uma âncora de horário gravada a cada ação, então
nenhum aparelho precisa escrever a cada segundo. Há exportação e importação
em JSON em todos os modos.

## Deploy (Coolify / Docker)

O `Dockerfile` roda `node server.js` (Node 24, SQLite embutido, sem npm).

| Item | Valor |
| --- | --- |
| Build pack | Dockerfile |
| Porta exposta | `3000` |
| Volume persistente | `/data` (banco SQLite e logo) |
| Health check | `GET /healthz` |
| Domínio | `https://poker.tudomudou.com.br` |

Variáveis de ambiente (ver `.env.example`):

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `3000` | porta interna |
| `DATA_DIR` | `/data` | pasta do banco e do logo |
| `ADMIN_PIN` | vazio | PIN pedido pela página para alterar dados; a TV só lê |

Recursos: o servidor é leve (um processo Node, SQLite em WAL). 128 MB de RAM e
uma fração de CPU bastam; o banco de uma liga inteira fica na casa dos
kilobytes a poucos megabytes.

API (usada pela própria página): `GET /api/state`, `GET /api/events` (SSE),
`GET /api/ranking` (ranking calculado em SQL), `PUT|DELETE
/api/{tournaments|players|games}/:id`, `PUT|DELETE /api/live`, `PUT
/api/settings`, `POST|DELETE /api/logo`, `GET /api/logo`. Escritas exigem o
cabeçalho `X-Admin-Pin` quando `ADMIN_PIN` está definido.

Tabelas: `tournaments`, `players`, `games` (documento JSON mais colunas de
busca), `game_results` (uma linha por jogador por partida: colocação, quem
eliminou, mão, prêmio, pontos), `live`, `settings`, `meta`.

Backup: copie `poker.sqlite` (e `logo.*`) do volume, ou use Exportar na página.

## Estrutura

```
index.html          página pronta, abre direto no navegador
server.js           servidor Node (SQLite + SSE) para hospedagem própria
Dockerfile          imagem para Coolify/Docker; docker-compose.yml para rodar local
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
