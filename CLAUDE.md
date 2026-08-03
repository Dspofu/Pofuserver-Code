# CLAUDE.md

Orientações para o Claude Code trabalhar neste repositório.

## O que é o projeto

**Pofuserver Coder Studio** — app desktop Electron que é um *agente de código*: conecta-se a
qualquer API REST compatível com OpenAI (llama.cpp, Ollama, vLLM…) e dá ao modelo ferramentas
para ler/escrever/editar/apagar arquivos do workspace, buscar por conteúdo no projeto, rodar
comandos no terminal (com processos em segundo plano), chamar APIs por HTTP, tirar print de
páginas web, pesquisar na web e anexar arquivos ao chat.

Idioma do projeto: **português**. Commits, comentários, prompts e UI são em pt-BR — mantenha isso.

## Estrutura

| Arquivo | Papel |
|---|---|
| [main.js](main.js) | Processo *main* do Electron. Todos os `ipcMain.handle` (fs, spawn de comandos, store, web search/fetch), janela e menu. |
| [preload.js](preload.js) | Ponte `contextBridge` → `window.electronAPI`. Toda nova capacidade do main precisa ser exposta aqui. |
| [index.html](index.html) | UI inteira: Tailwind (vendorizado), `<style>` grande no topo, markup e modais. Carrega os módulos ao final. |
| [src/renderer.js](src/renderer.js) | Cérebro do renderer: estado dos chats, loop do agente, definição das `tools`, streaming, execução de tool calls, render de mensagens. |
| [src/constants.js](src/constants.js) | `system_prompt`, `DEFAULT_SETTINGS` e os limites, todos comentados com o *porquê*: janela de leitura derivada do contexto, orçamento de histórico, prints por requisição, retries e trava de loop. |
| [src/websearch.js](src/websearch.js) | **Arquivo gerado** — não edite. Saída do `tsc` sobre o módulo portátil `…/chat/src/lib/websearch.ts`. Cascata de buscadores, pontuação de relevância, cache e cooldown. |
| `vendor/` | Libs offline do RENDERER (tailwind, marked, purify, highlight). Sem CDN. |
| `build/`, `dist/` | Recursos e saída do electron-builder. |

## Comandos

```bash
npm start        # electron --no-sandbox . --ozone-platform=x11
npm run dist     # empacota .deb + .nsis
npm run dist:linux
```

Não há testes nem linter. Verificação = rodar o app e exercitar o fluxo alterado.

## Fluxo de uma alteração no agente

Uma ferramenta nova exige tocar em **quatro** pontos, na ordem:

1. `ipcMain.handle('nome', …)` em [main.js](main.js)
2. exposição em [preload.js](preload.js)
3. entrada no array `tools` em [src/renderer.js:1204](src/renderer.js#L1204) (schema JSON enviado ao modelo)
4. o `case` no executor `runTool` ([src/renderer.js:1553](src/renderer.js#L1553)), a entrada em
   `TOOL_META` e os `switch` de rótulo/resumo em [src/renderer.js:709](src/renderer.js#L709)
   e [src/renderer.js:749](src/renderer.js#L749)

Esquecer o passo 4 gera tool call que "funciona" mas aparece cru na UI.

## README — mantenha atualizado

O [README.md](README.md) é a vitrine do projeto e **envelhece rápido**: quando foi reescrito,
metade das ferramentas do agente não estava documentada lá. Toda alteração que muda o que o
usuário vê ou pode fazer exige atualizar o README **no mesmo commit**:

- ferramenta nova, renomeada ou removida → tabela de ferramentas
- funcionalidade ou opção nova na UI → seção correspondente + captura, se for visual
- mudança em requisitos, instalação ou configuração → as seções respectivas

As imagens ficam em `docs/img/` e são geradas do app REAL (nunca mockup). Se a interface
mudou, refaça a captura afetada em vez de deixar a antiga: print desatualizado engana mais
que a ausência dele.

## Convenções

- ES modules (`"type": "module"`) no main; renderer também usa `type="module"`.
- Sem framework de UI: DOM imperativo (`document.createElement`). Siga o padrão dos
  `render*`/`build*` existentes em vez de introduzir templates ou libs.
- Comentários explicam **por quê**, não o quê — veja [src/constants.js](src/constants.js), que
  documenta o motivo de cada limite (ex.: `maxTokens` alto porque modelos de raciocínio gastam
  orçamento no bloco de think e cortam o JSON do tool call). Mantenha esse estilo ao mexer em
  qualquer constante ou heurística.
- Mudanças de comportamento do agente quase sempre significam ajustar o `system_prompt` em
  [src/constants.js](src/constants.js) — não espalhe instruções pelo renderer.

## Armadilhas conhecidas

- **Leitura paginada**: `read_file` devolve janelas de linhas com aviso de `offset`. Não volte a
  truncar em silêncio — foi a causa de o modelo apagar arquivos ao reescrevê-los. A janela é
  recortada no **main**; o renderer só formata (`formatFileWindow`). Não volte a mandar o arquivo
  inteiro pelo IPC. O tamanho da janela NÃO é constante: `readCharBudget(n_ctx)` tira uma fatia
  do contexto do modelo em uso, porque um número fixo é pequeno demais num modelo de 65k e
  grande demais num de 8k.
- **`edit_file` antes de `write_file`**: alterar arquivo existente é trabalho de `edit_file`
  (troca de trecho exato). Reescrever tudo com `write_file` gasta tokens de saída à toa e a
  geração é cortada no meio, truncando o arquivo. O prompt e as descrições das ferramentas
  reforçam isso — não afrouxe.
- **Prints e visão**: `capture_page` abre a URL numa `BrowserWindow` oculta (`offscreen: true`,
  necessário para o `capturePage()` não sair em branco) e devolve `{ text, image }`. O PNG vai
  para `userData/screenshots`; no histórico fica só o **caminho** (o base64 mora em `shotCache`,
  em memória) — persistir o base64 inflaria o `app-store.json`. O reenvio ao modelo só acontece
  quando o `/v1/models` anuncia `capabilities: multimodal` (`detectVision`): mandar `image_url`
  para modelo de texto derruba a requisição inteira. `full_page` aumenta a janela até a altura do
  documento antes de capturar — sem ele o agente valida só a primeira dobra e declara "tudo
  certo" sem ter visto o rodapé. Só os `MAX_VISION_IMAGES` prints mais
  recentes voltam, porque cada imagem custa milhares de tokens de visão.
- **HTTP 500 do llama.cpp**: tool call malformado é transitório; existem `MAX_REQUEST_RETRIES`
  e limpeza do histórico. Preserve esse tratamento ao mexer no loop de request.
- **Compactação de contexto** (`compactToolResults`): sem ela o histórico cresce até estourar
  o `n_ctx` e a sessão morre. Duas regras que não podem cair: a mensagem `tool` nunca é
  REMOVIDA (um `tool_call` órfão faz o servidor recusar a requisição inteira, só o `content`
  é trocado), e a poda vale só para o **payload** — `chat.messages` continua íntegro em disco
  e na tela. O orçamento desconta o prompt de sistema e `maxTokens` do `n_ctx`; por isso
  `runAgent` faz `await refreshModelContext()` na primeira requisição — sem o `n_ctx` a poda
  não teria como dimensionar nada, justamente na conversa longa recém-reaberta.
- **Escrita sem leitura**: `write_file` recusa sobrescrever arquivo existente que não está em
  `arquivosLidos` (a checagem mora no main, junto da escrita, para não haver intervalo entre
  verificar e gravar). Criar arquivo novo passa livre. O conjunto zera ao trocar de chat.
- **Processos longos**: comandos que passam de `cmdTimeout` viram background e retornam PID,
  acompanhados por `read_process_output`/`stop_process`. Não converta isso em execução bloqueante.
  `wait_for_process` existe para o agente ESPERAR num turno só: sem ele, o modelo chamava
  `read_process_output` em looping ("já acabou?"), gastando o contexto inteiro num `npm install`.
- **Diff e desfazer**: toda escrita/edição/remoção grava um instantâneo em
  `userData/instantaneos` e devolve `snapshotId` + `diff`. O diff é do USUÁRIO — `comAlteracao`
  o remove do que vai ao modelo, senão cada edição custaria em contexto o dobro do arquivo. No
  histórico fica só o `snapshotId` (o `antes`/`depois` mora no instantâneo, e `get-diff`
  remonta na recarga). O desfazer também cria um instantâneo, e é isso que permite refazer.
  `calculaDiff` apara prefixo/sufixo iguais ANTES do LCS — sem isso a matriz teria o tamanho do
  arquivo e travaria o main —, mas depois reinsere esse entorno como contexto, senão o diff vira
  uma lista de linhas soltas.
- **Falha de requisição**: `classificaErroDeRequisicao` traduz o erro em causa + passos e diz se
  vale repetir. Só 5xx é transitório; servidor fora do ar, 401 e 404 falham igual nas três
  tentativas e só atrasam o diagnóstico. Não volte a mostrar a exceção crua.
- **Confirmação**: `CONFIRM_TOOLS` (`execute_command`, `delete_file`, `http_request` fora de
  GET/HEAD/OPTIONS) e `execMode` `manual`/`auto` controlam o modal de aprovação. O valor pode ser
  `true` ou um teste sobre os argumentos. Ferramentas destrutivas novas devem entrar aí — e quem
  ganhar rótulo próprio no modal precisa de um `else if` em `showConfirmModal`.
- **Busca na web**: buscador NÃO se raspa por `fetch`. Medido em 01/08/2026: DuckDuckGo e
  Startpage devolvem 202/captcha e o Bing cai num muro de consentimento — mas o MESMO
  DuckDuckGo responde normalmente dentro de uma `BrowserWindow` oculta. Por isso o provedor
  `ddg-navegador` (via `comJanelaOculta`) entra em `extraProviders` e é o que ganha na prática;
  os scrapers HTTP ficam como reserva para outras redes. Não troque isso por `fetch` "para
  simplificar" — volta a falhar. A instância de `WebSearch` é única de propósito: cache e
  cooldown por provedor só servem se sobreviverem entre as buscas.
- **`loadURL` sem prazo trava**: ele só resolve no `did-finish-load`; numa página que nunca
  termina de carregar (anúncio pendurado, websocket) fica preso PARA SEMPRE e o tool call do
  agente nunca retorna. Todo `loadURL` aqui corre contra um `sleep` e chama `stop()` no
  estouro, aproveitando o que já renderizou.
- **Servidor local**: a porta e o modelo do llama.cpp variam — confirme com o usuário antes de
  assumir `http://localhost:8080/v1`.
- **`build/icon.ico` não pode ser PNG puro**: um `.ico` cujas imagens estão todas comprimidas em
  PNG deixa o EXE com ícone (o Explorer usa `SHGetFileInfo`, que lê PNG) mas o ATALHO `.lnk` em
  branco — desenhar o ícone com a setinha de atalho passa por `ExtractIconEx`, que só aceita
  bitmap não comprimido nos tamanhos pequenos. Por isso as imagens até 128px estão gravadas
  como DIB 32bpp (BGRA de baixo para cima + máscara AND zerada) e só a de 256px segue em PNG,
  que é o único tamanho onde a compressão é oficialmente suportada. Se regerar o ícone a partir
  dos PNGs de `build/icons/`, confira com `file build/icon.ico`: aparecer "with PNG image data"
  nos tamanhos pequenos é o bug de volta.

## Git

Branch principal: `main`. O usuário costuma pedir "commit" significando commit + push na `main`.
Mensagens em português, com prefixo (`feat:`, `fix:`, `docs:`, `update:`).
