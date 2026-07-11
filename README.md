# Pofuserver Coder Studio

**Agente de código em desktop** (Electron) que se conecta a **qualquer API REST compatível com OpenAI** — como [llama.cpp](https://github.com/ggml-org/llama.cpp), [Ollama](https://ollama.com/) ou [vLLM](https://github.com/vllm-project/vllm) — e opera diretamente sobre os arquivos do seu projeto local: lê, escreve, apaga arquivos e executa comandos no terminal, tudo a partir de um chat.

Pense nele como um "Cursor/Claude Code" local, rodando com o **seu** modelo, **offline** e sem depender de nuvem.

---

## Funcionalidades

### Agente com ferramentas
O modelo age no seu workspace através de ferramentas (function calling):

| Ferramenta | O que faz |
|---|---|
| `list_files` | Lista arquivos e pastas do diretório de trabalho |
| `read_file` | Lê o conteúdo de um arquivo |
| `write_file` | Cria ou sobrescreve um arquivo |
| `create_directory` | Cria uma pasta (e diretórios pai, se necessário) |
| `delete_file` | Apaga um arquivo |
| `execute_command` | Roda um comando no terminal (dentro do workspace) |
| `read_process_output` | Lê os logs de um processo em segundo plano |
| `list_processes` | Lista os processos em segundo plano ativos |
| `stop_process` | Encerra um processo em segundo plano |
| `web_search` | Busca na web (DuckDuckGo) — opcional, ative em *Ajustes → Ferramentas* |
| `fetch_url` | Lê o conteúdo de uma página web a partir de uma URL |

### Execução inteligente de processos
- **Servidores/APIs não travam o chat.** Quando você pede para subir um servidor (`npm run dev`, `node app.js`, etc.), ele é detectado automaticamente — por padrão de log ("listening on…") ou por ociosidade — e passa a rodar **em segundo plano**, retornando um PID. O agente continua livre para rodar outros comandos (testar a API, `curl`, etc.) enquanto o servidor está de pé.
- **Builds e tarefas longas** (que imprimem saída contínua) seguem sendo aguardadas normalmente até terminarem.
- **`sudo` não sequestra seu terminal:** os comandos rodam desacoplados do terminal, então o `sudo` falha de forma limpa em vez de pedir senha no shell onde o app foi iniciado.
- Você controla os processos em segundo plano: ver logs, listar e **parar** (encerra o grupo inteiro).

### Streaming em tempo real
- O **raciocínio** do modelo (ex.: Qwen3) e o **texto da resposta** aparecem sendo gerados, com cursor pulsante.
- Ao finalizar, o texto é re-renderizado em **Markdown** com **realce de sintaxe** e **botão de copiar** nos blocos de código.
- **Botão de Parar:** durante a geração, o botão de enviar vira um botão de parar que aborta na hora.

### Anexos de arquivos
- Anexe arquivos ao chat pelo botão de clipe ou arrastando e soltando na janela.
- Arquivos de texto/código são lidos e injetados no contexto do modelo (com truncamento sinalizado para arquivos grandes).

### Editar e regenerar
- **Editar** qualquer mensagem sua: devolve o texto (e anexos) ao campo de digitação e reenvia.
- **Regenerar** qualquer resposta do agente, refazendo a partir da sua última solicitação.

### Múltiplos chats e workspaces
- Vários chats independentes, cada um com sua **própria pasta de trabalho**.
- Histórico **persistido localmente** (sobrevive ao fechar o app).

### Painel e configurações
- **Medidor de contexto** sempre visível no cabeçalho (tokens usados / comprimento total do modelo).
- Abas de **informações do modelo** (quantização, contexto, tamanho, parâmetros) e **uso de tokens** da sessão.
- Ajustes: endpoint da API, API key (opcional), seleção de modelo, **temperatura**, **top-p**, **máximo de tokens**, **timeout de comando** e um interruptor `/no_think` para modelos de raciocínio.

### Offline
Todas as bibliotecas de front-end (Markdown, sanitização, realce de sintaxe, estilos) são **vendorizadas localmente** em `vendor/` — o app não depende de CDN em tempo de execução.

---

## Requisitos

- **[Node.js](https://nodejs.org/)** 18+ (com `npm`).
- Um **servidor de modelo compatível com OpenAI** rodando localmente (ex.: llama.cpp). Por padrão o app aponta para `http://localhost:8080/v1`.
- Linux, Windows ou macOS. *(O script `npm start` já vem com flags voltadas para Linux — veja as notas abaixo.)*

---

## Instalação (via Node)

```bash
# 1. Clone o repositório
git clone https://github.com/Dspofu/Pofuserver-Code.git
cd Pofuserver-Code

# 2. Instale as dependências (baixa o Electron)
npm install

# 3. Inicie o app
npm start
```

> **Outros sistemas / problemas com as flags:** o script `start` usa `--no-sandbox --ozone-platform=x11` (útil no Linux). Em Windows/macOS, ou se der erro, rode diretamente:
> ```bash
> npx electron .
> ```

---

## Configuração

Abra o app e clique no ícone de engrenagem → aba **Personalização**:

1. **Endpoint da API** — padrão `http://localhost:8080/v1` (formato compatível com OpenAI).
2. **Modelo** — clique em *Recarregar modelos* para listar o que o endpoint expõe e selecione.
3. **API Key** — opcional (deixe vazio para servidores locais).
4. Ajuste **temperatura**, **top-p**, **máximo de tokens** e **timeout de comando** conforme necessário.

### Exemplo de servidor com llama.cpp

```bash
# Sobe um servidor OpenAI-compatível na porta 8080
llama-server -m /caminho/para/seu-modelo.gguf --port 8080 --jinja
```

Modelos com suporte a **function calling** (chamadas de ferramenta) são recomendados, pois o agente depende disso para ler/escrever arquivos e rodar comandos. Para modelos de raciocínio (ex.: Qwen3), mantenha o raciocínio **ligado** (não use `/no_think`) para que as ferramentas funcionem bem.

---

## Como usar

1. **Crie/selecione um chat** na barra lateral.
2. **Escolha a pasta de trabalho** do chat pelo ícone de pasta no cabeçalho — é o diretório onde o agente vai ler/escrever/rodar comandos.
3. **Converse.** Peça, por exemplo: *"liste os arquivos e crie um servidor Express simples na porta 3000 e suba ele"*.
4. Acompanhe o raciocínio e as ações (cards de ferramenta) em tempo real. Passe o mouse sobre as mensagens para **editar** ou **regenerar**.
5. Anexe arquivos pelo botão de clipe ou arrastando-os para a janela.

---

## Estrutura do projeto

```
├── main.js        # Processo principal do Electron: janela, IPC, sistema de arquivos e execução de processos
├── preload.js     # Ponte segura (contextBridge) entre renderer e main
├── renderer.js    # Lógica da interface: chats, loop do agente, streaming, ferramentas, anexos
├── index.html     # Interface e estilos
├── vendor/        # Bibliotecas de front-end vendorizadas (offline)
└── package.json
```

---

## Créditos

- Ícone do aplicativo gerado com **ChatGPT (OpenAI)**.

## Notas

- O histórico e as configurações são salvos no diretório de dados do usuário do Electron (`app-store.json`).
- O app foi construído e testado principalmente no **Linux**, contra um servidor **llama.cpp** local.
- A **busca na web** usa o DuckDuckGo (sem chave de API) e é opcional — ative em *Ajustes → Ferramentas*.
- A dependência `openai` consta no `package.json`, mas a comunicação é feita via `fetch` direto ao endpoint compatível.

---

## Licença

Este é um **software livre**: qualquer pessoa pode usar, copiar, modificar, redistribuir e criar versões derivadas deste projeto, para fins pessoais ou comerciais, sem necessidade de autorização prévia. Veja o arquivo [LICENSE](LICENSE) para o texto completo.
