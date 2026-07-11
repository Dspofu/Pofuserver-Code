// ==========================================================================
//  Pofuserver Coder Studio — lógica do renderer
//  Conecta a uma API REST compatível com OpenAI (ex: llama.cpp, Ollama, vLLM)
// ==========================================================================

const DEFAULT_SETTINGS = {
  apiUrl: 'http://localhost:8080/v1',
  model: '',
  apiKey: '',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 2048,
  noThink: false, // modelos de raciocínio (ex: Qwen3) precisam pensar para chamar ferramentas
  cmdTimeout: 20 // segundos até um comando ser considerado "rodando em segundo plano"
};

const MAX_TOOL_RESULT_CHARS = 6000; // evita estourar o contexto de modelos pequenos
// Trava de segurança ALTA apenas contra loop verdadeiramente infinito; o controle
// real é o botão "Parar". Tarefas longas e legítimas rodam sem serem bloqueadas.
const MAX_LOOP_ITERATIONS = 100;

let state = {
  chats: {},          // { id: { id, name, path, messages: [] } }
  activeChatId: null,
  settings: { ...DEFAULT_SETTINGS },
  usage: { prompt: 0, completion: 0, requests: 0, history: [], lastTotal: 0 },
  modelCtx: 0
};

let isRunning = false;
let stopRequested = false;   // usuário pediu para parar a geração
let abortController = null;   // aborta o fetch em streaming em andamento

function stopAgent() {
  stopRequested = true;
  if (abortController) { try { abortController.abort(); } catch (e) {} }
}

function scrollChat() {
  const cb = document.getElementById('chat-box');
  cb.scrollTop = cb.scrollHeight;
}

// --------------------------------------------------------------------------
//  Persistência (via IPC para o diretório de dados do usuário)
// --------------------------------------------------------------------------
async function persist() {
  await window.electronAPI.saveStore({
    chats: state.chats,
    activeChatId: state.activeChatId,
    settings: state.settings
  });
}

async function loadPersisted() {
  const data = await window.electronAPI.loadStore();
  if (data && data.chats && Object.keys(data.chats).length > 0) {
    state.chats = data.chats;
    state.activeChatId = data.activeChatId && data.chats[data.activeChatId]
      ? data.activeChatId
      : Object.keys(data.chats)[0];
    state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  } else {
    if (data && data.settings) state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    createChat('Chat Inicial');
  }
}

// --------------------------------------------------------------------------
//  Gerenciamento de Chats
// --------------------------------------------------------------------------
function createChat(name) {
  const id = 'chat_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  state.chats[id] = { id, name: name || 'Novo Chat', path: '', messages: [] };
  state.activeChatId = id;
  return id;
}

function activeChat() {
  return state.chats[state.activeChatId];
}

function renderChatList() {
  const container = document.getElementById('chat-list-container');
  container.innerHTML = '';

  Object.keys(state.chats).forEach(id => {
    const chat = state.chats[id];
    const item = document.createElement('div');
    item.className = `chat-item ${id === state.activeChatId ? 'active' : ''}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.innerText = chat.name;
    item.appendChild(nameSpan);

    const del = document.createElement('button');
    del.className = 'chat-delete';
    del.title = 'Apagar chat';
    del.innerText = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(id);
    });
    item.appendChild(del);

    item.addEventListener('click', () => switchChat(id));
    container.appendChild(item);
  });
}

function switchChat(id) {
  if (!state.chats[id]) return;
  state.activeChatId = id;
  renderChatList();
  renderActiveChat();
  persist();
}

function deleteChat(id) {
  delete state.chats[id];
  if (state.activeChatId === id) {
    const remaining = Object.keys(state.chats);
    if (remaining.length === 0) createChat('Chat Inicial');
    else state.activeChatId = remaining[0];
  }
  renderChatList();
  renderActiveChat();
  persist();
}

// Reconstrói a visualização do chat ativo a partir do histórico real de mensagens
function renderActiveChat() {
  const chat = activeChat();
  document.getElementById('active-chat-title').innerText = chat.name;
  document.getElementById('selected-path').innerText = chat.path || 'Selecionar ambiente';

  const chatBox = document.getElementById('chat-box');
  chatBox.innerHTML = '';

  // Indexa os resultados de ferramenta por tool_call_id para parear com suas chamadas
  const toolResults = {};
  for (const m of chat.messages) {
    if (m.role === 'tool' && m.tool_call_id) toolResults[m.tool_call_id] = m.content;
  }

  for (let i = 0; i < chat.messages.length; i++) {
    const msg = chat.messages[i];
    if (msg.role === 'user') {
      renderUserMessage(msg.content, msg.attachments, i);
    } else if (msg.role === 'assistant') {
      if (msg.content) appendMessage(msg.content, 'agent', i);
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const name = (tc.function && tc.function.name) || 'ferramenta';
          let args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { args = {}; }
          const result = tc.id != null ? toolResults[tc.id] : undefined;
          renderToolInvocation(name, args, result ?? null);
        }
      }
    }
    // mensagens 'tool' são renderizadas junto com sua chamada (acima) — nada a fazer aqui
  }

  updateInputState();
}

const SEND_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function updateInputState() {
  const hasPath = !!(activeChat() && activeChat().path);
  const input = document.getElementById('user-input');
  const btn = document.getElementById('btn-send');
  const attach = document.getElementById('btn-attach');
  input.disabled = !hasPath || isRunning;
  if (attach) attach.disabled = !hasPath || isRunning;
  document.body.classList.toggle('agent-running', isRunning);

  // Enquanto roda, o botão de enviar vira botão de PARAR (sempre clicável)
  if (isRunning) {
    btn.disabled = false;
    btn.classList.add('is-stop');
    btn.title = 'Parar geração';
    btn.innerHTML = STOP_SVG;
  } else {
    btn.disabled = !hasPath;
    btn.classList.remove('is-stop');
    btn.title = 'Enviar mensagem';
    btn.innerHTML = SEND_SVG;
  }

  input.placeholder = hasPath
    ? 'Peça algo, anexe arquivos (📎 ou arraste) ou peça para rodar um comando…'
    : 'Selecione uma pasta de trabalho para este chat (ícone acima) →';
}

// --------------------------------------------------------------------------
//  Renderização de mensagens
// --------------------------------------------------------------------------
// Configura o marked uma vez (se disponível)
if (window.marked && window.marked.setOptions) {
  window.marked.setOptions({ gfm: true, breaks: true });
}

// Renderiza markdown com sanitização e realce de código dentro de um container
function renderMarkdownInto(container, text) {
  const hasLibs = window.marked && window.DOMPurify;
  if (!hasLibs) {
    container.innerText = text; // fallback seguro
    return;
  }
  const rawHtml = window.marked.parse(text);
  container.innerHTML = window.DOMPurify.sanitize(rawHtml);

  // Realça e decora cada bloco de código
  container.querySelectorAll('pre > code').forEach(codeEl => {
    if (window.hljs) {
      try { window.hljs.highlightElement(codeEl); } catch (e) { /* ignora */ }
    }
    const pre = codeEl.parentElement;
    const lang = (codeEl.className.match(/language-(\w+)/) || [])[1]
      || (codeEl.className.match(/\blang-(\w+)/) || [])[1]
      || (window.hljs && codeEl.result && codeEl.result.language)
      || 'código';

    // Envolve em .code-block com cabeçalho e botão de copiar
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const header = document.createElement('div');
    header.className = 'code-header';
    const langSpan = document.createElement('span');
    langSpan.innerText = lang;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.innerText = 'Copiar';
    copyBtn.addEventListener('click', () => {
      const done = () => {
        copyBtn.innerText = 'Copiado!';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.innerText = 'Copiar'; copyBtn.classList.remove('copied'); }, 1500);
      };
      const text = codeEl.innerText;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      } else {
        fallbackCopy(text, done);
      }
    });
    header.appendChild(langSpan);
    header.appendChild(copyBtn);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });
}

function fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); onDone && onDone(); } catch (e) { /* ignora */ }
  document.body.removeChild(ta);
}

function appendMessage(text, sender, index) {
  const chatBox = document.getElementById('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${sender}`;
  if (sender === 'agent') {
    const body = document.createElement('div');
    body.className = 'md-body';
    renderMarkdownInto(body, text);
    msgDiv.appendChild(body);
    attachMsgAction(msgDiv, 'regenerate', index);
  } else {
    msgDiv.innerText = text; // mensagens do usuário sempre como texto puro
  }
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Bolha do usuário, com chips de anexos (usada ao vivo e no reload do histórico)
function renderUserMessage(text, attachments, index) {
  const chatBox = document.getElementById('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message user';
  if (attachments && attachments.length) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-attachments';
    attachments.forEach(a => {
      const chip = document.createElement('span');
      chip.className = 'msg-attach-chip';
      chip.innerText = `${a.binary ? '🗎' : '📄'} ${a.name}`;
      chip.title = a.name;
      wrap.appendChild(chip);
    });
    msgDiv.appendChild(wrap);
  }
  if (text) {
    const t = document.createElement('div');
    t.innerText = text;
    msgDiv.appendChild(t);
  }
  attachMsgAction(msgDiv, 'edit', index);
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Barra de ações da mensagem (aparece no hover): editar (usuário) / regenerar (agente)
function attachMsgAction(msgDiv, kind, index) {
  if (index == null) return;
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  const btn = document.createElement('button');
  btn.className = 'msg-action-btn';
  if (kind === 'edit') {
    btn.title = 'Editar e reenviar (descarta as respostas seguintes)';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Editar</span>';
    btn.addEventListener('click', () => editUserMessage(index));
  } else {
    btn.title = 'Regenerar resposta';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>Regenerar</span>';
    btn.addEventListener('click', () => regenerateFromAssistant(index));
  }
  bar.appendChild(btn);
  msgDiv.appendChild(bar);
}

// Reenvia a partir de uma mensagem do usuário: coloca no composer e trunca o histórico
function editUserMessage(index) {
  if (isRunning) return;
  const chat = activeChat();
  const msg = chat.messages[index];
  if (!msg || msg.role !== 'user') return;
  const input = document.getElementById('user-input');
  input.value = msg.content || '';
  pendingAttachments = (msg.attachments || []).map(a => ({ ...a }));
  renderAttachments();
  chat.messages = chat.messages.slice(0, index); // remove esta solicitação e tudo depois
  renderActiveChat();
  persist();
  input.focus();
  input.dispatchEvent(new Event('input')); // recalcula a altura do textarea
}

// Regenera a resposta: descarta do 'assistant' clicado em diante e roda de novo
function regenerateFromAssistant(index) {
  if (isRunning) return;
  const chat = activeChat();
  let userIdx = -1;
  for (let i = Math.min(index, chat.messages.length) - 1; i >= 0; i--) {
    if (chat.messages[i].role === 'user') { userIdx = i; break; }
  }
  if (userIdx === -1) return;
  chat.messages = chat.messages.slice(0, userIdx + 1); // mantém até a solicitação do usuário
  renderActiveChat();
  runAgent();
}

function appendInfo(text) {
  const chatBox = document.getElementById('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = "info";
  msgDiv.innerText = text;
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function logSystem(text) {
  const chatBox = document.getElementById('chat-box');
  const logDiv = document.createElement('div');
  logDiv.className = 'system-log';
  logDiv.innerText = `[SISTEMA]: ${text}`;
  chatBox.appendChild(logDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendToolLog(text) {
  const chatBox = document.getElementById('chat-box');
  const div = document.createElement('div');
  div.className = 'tool-log';
  div.innerText = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ---- Cards de ferramenta (exibição amigável, sem JSON cru) ----
const TOOL_META = {
  list_files:          { icon: '📁', label: 'Listar arquivos' },
  read_file:           { icon: '📄', label: 'Ler arquivo' },
  write_file:          { icon: '✏️', label: 'Escrever arquivo' },
  delete_file:         { icon: '🗑️', label: 'Apagar arquivo' },
  execute_command:     { icon: '⌘', label: 'Terminal' },
  read_process_output: { icon: '📜', label: 'Saída do processo' },
  list_processes:      { icon: '📋', label: 'Processos' },
  stop_process:        { icon: '⛔', label: 'Parar processo' }
};

// Resumo legível dos argumentos da chamada
function summarizeToolCall(name, args) {
  args = args || {};
  switch (name) {
    case 'execute_command':     return '$ ' + (args.command || '');
    case 'read_file':
    case 'write_file':
    case 'delete_file':         return args.filename || '';
    case 'list_files':          return args.subpath ? args.subpath + '/' : './';
    case 'read_process_output':
    case 'stop_process':        return 'PID ' + (args.pid ?? '?');
    case 'list_processes':      return '';
    default: {
      const keys = Object.keys(args);
      return keys.map(k => `${k}: ${String(args[k]).slice(0, 60)}`).join('  ');
    }
  }
}

// Resumo legível do resultado (a maioria vem como JSON string)
function summarizeToolResult(name, resultStr) {
  if (resultStr == null) return '';
  if (name === 'read_file') {
    const lines = resultStr.split('\n').length;
    return `✓ ${lines} linha(s) lidas`;
  }
  let data;
  try { data = JSON.parse(resultStr); } catch { return resultStr; }
  if (data && data.error) return `⚠ ${data.error}`;

  switch (name) {
    case 'execute_command': {
      if (data.backgrounded) {
        const head = `▸ rodando em segundo plano · PID ${data.pid} (${data.reason || 'contínuo'})`;
        const out = (data.stdout || '').trim();
        return out ? `${head}\n${out}` : head;
      }
      const parts = [];
      if (data.stdout && data.stdout.trim()) parts.push(data.stdout.trim());
      if (data.stderr && data.stderr.trim()) parts.push(data.stderr.trim());
      let body = parts.join('\n').trim() || '(sem saída)';
      if (data.exitCode) body += `\n[código de saída: ${data.exitCode}]`;
      return body;
    }
    case 'list_files':
      return Array.isArray(data)
        ? (data.map(f => (f.isDirectory ? '📁 ' : '📄 ') + f.name).join('\n') || '(pasta vazia)')
        : resultStr;
    case 'write_file':  return data.success ? '✓ Arquivo salvo' : (data.error || resultStr);
    case 'delete_file': return data.success ? '✓ Arquivo apagado' : (data.error || resultStr);
    case 'stop_process':return data.success ? `✓ Processo ${data.pid} encerrado` : (data.error || resultStr);
    case 'list_processes':
      return Array.isArray(data)
        ? (data.length ? data.map(p => `PID ${p.pid} · ${p.status} · ${p.uptimeSec}s · ${p.command}`).join('\n') : '(nenhum processo em segundo plano)')
        : resultStr;
    case 'read_process_output': {
      if (!data.success) return data.error || resultStr;
      const head = `PID ${data.pid} · ${data.status} · ${data.uptimeSec}s`;
      const out = [data.stdout, data.stderr].filter(x => x && x.trim()).join('\n').trim();
      return out ? `${head}\n${out}` : head;
    }
    default: return resultStr;
  }
}

// Cria o card da chamada (cabeçalho + argumento). Retorna o elemento para preencher o resultado depois.
function appendToolCall(name, args) {
  const meta = TOOL_META[name] || { icon: '🔧', label: name };
  const chatBox = document.getElementById('chat-box');
  const card = document.createElement('div');
  card.className = 'tool-card';

  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML = `<span class="tool-icon"></span><span class="tool-title"></span>`;
  head.querySelector('.tool-icon').innerText = meta.icon;
  head.querySelector('.tool-title').innerText = meta.label;
  card.appendChild(head);

  const argText = summarizeToolCall(name, args);
  if (argText) {
    const arg = document.createElement('pre');
    arg.className = 'tool-arg';
    arg.innerText = argText;
    card.appendChild(arg);
  }

  chatBox.appendChild(card);
  chatBox.scrollTop = chatBox.scrollHeight;
  return card;
}

// Preenche (ou atualiza) o resultado dentro do card da chamada
function fillToolResult(card, name, resultStr) {
  if (!card) return;
  let res = card.querySelector('.tool-result');
  if (!res) {
    res = document.createElement('pre');
    res.className = 'tool-result';
    card.appendChild(res);
  }
  const text = summarizeToolResult(name, resultStr);
  res.innerText = truncate(text, 1200);
  res.classList.toggle('is-error', /^⚠/.test(text));
  document.getElementById('chat-box').scrollTop = document.getElementById('chat-box').scrollHeight;
}

// Card completo (chamada + resultado) — usado ao recarregar o histórico
function renderToolInvocation(name, args, resultStr) {
  const card = appendToolCall(name, args);
  if (resultStr != null) fillToolResult(card, name, resultStr);
  return card;
}

function appendReasoning(text) {
  const chatBox = document.getElementById('chat-box');
  const details = document.createElement('details');
  details.className = 'reasoning';
  const summary = document.createElement('summary');
  summary.innerText = 'Raciocínio do modelo';
  const body = document.createElement('div');
  body.className = 'reasoning-body';
  body.innerText = text;
  details.appendChild(summary);
  details.appendChild(body);
  chatBox.appendChild(details);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendError(text) {
  const chatBox = document.getElementById('chat-box');
  const div = document.createElement('div');
  div.className = 'error-msg';
  div.innerText = `⚠ ${text}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function showTyping() {
  const chatBox = document.getElementById('chat-box');
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.id = 'typing-indicator';
  div.innerHTML = '<span></span><span></span><span></span>';
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function truncate(str, max) {
  if (typeof str !== 'string') str = String(str);
  return str.length > max ? str.slice(0, max) + `\n… (truncado, ${str.length} caracteres)` : str;
}

// --------------------------------------------------------------------------
//  Definição das Ferramentas expostas ao modelo
// --------------------------------------------------------------------------
const tools = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lista arquivos e pastas do diretório de trabalho (ou de uma subpasta).',
      parameters: {
        type: 'object',
        properties: {
          subpath: { type: 'string', description: 'Subpasta relativa opcional (padrão: raiz do workspace)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lê o conteúdo de um arquivo específico no workspace.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Nome ou caminho relativo do arquivo' }
        },
        required: ['filename']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Cria ou sobrescreve um arquivo com um conteúdo específico.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Nome do arquivo a ser salvo' },
          content: { type: 'string', description: 'Conteúdo completo a ser escrito no arquivo' }
        },
        required: ['filename', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Apaga um arquivo do workspace.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Nome ou caminho relativo do arquivo a apagar' }
        },
        required: ['filename']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Executa um comando shell no workspace. Comandos que terminam retornam stdout/stderr. ' +
        'Servidores/APIs/watchers são detectados automaticamente: assim que ficam prontos (banner de log ' +
        'ou ociosidade) retornam um PID e seguem rodando em SEGUNDO PLANO, sem travar o chat — você pode ' +
        'continuar executando outros comandos (curl, testes, etc.) enquanto o servidor roda. Evite sudo.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando shell para rodar (ex: npm run dev, node app.js, curl localhost:3000)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_process_output',
      description: 'Lê os logs (stdout/stderr) acumulados de um processo em segundo plano pelo seu PID. ' +
        'Útil para verificar se um servidor subiu bem ou depurar erros.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: 'PID retornado por execute_command' }
        },
        required: ['pid']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_processes',
      description: 'Lista os processos em segundo plano (PID, comando, status, tempo de execução).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stop_process',
      description: 'Encerra um processo em segundo plano (e seu grupo) pelo PID retornado por execute_command.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: 'PID do processo a encerrar' }
        },
        required: ['pid']
      }
    }
  }
];

async function runTool(name, args, workspace) {
  try {
    if (name === 'list_files') {
      const dir = args.subpath ? `${workspace}/${args.subpath}` : workspace;
      const files = await window.electronAPI.listFiles(dir);
      return JSON.stringify(files);
    }
    if (name === 'read_file') {
      const content = await window.electronAPI.readFile(`${workspace}/${args.filename}`);
      return truncate(content, MAX_TOOL_RESULT_CHARS);
    }
    if (name === 'write_file') {
      const res = await window.electronAPI.writeFile(`${workspace}/${args.filename}`, args.content ?? '');
      return JSON.stringify(res);
    }
    if (name === 'delete_file') {
      const res = await window.electronAPI.deleteFile(`${workspace}/${args.filename}`);
      return JSON.stringify(res);
    }
    if (name === 'execute_command') {
      const timeoutMs = (state.settings.cmdTimeout || 25) * 1000;
      const res = await window.electronAPI.executeCommand(args.command, workspace, { timeoutMs });
      return truncate(JSON.stringify(res), MAX_TOOL_RESULT_CHARS);
    }
    if (name === 'read_process_output') {
      const res = await window.electronAPI.readProcessOutput(args.pid);
      return truncate(JSON.stringify(res), MAX_TOOL_RESULT_CHARS);
    }
    if (name === 'list_processes') {
      const res = await window.electronAPI.listProcesses();
      return JSON.stringify(res);
    }
    if (name === 'stop_process') {
      const res = await window.electronAPI.stopProcess(args.pid);
      return JSON.stringify(res);
    }
    return `Ferramenta desconhecida: ${name}`;
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

// --------------------------------------------------------------------------
//  Loop do Agente
// --------------------------------------------------------------------------
async function submitUserMessage(userPrompt, attachments) {
  const chat = activeChat();
  if (!state.settings.model) {
    appendError('Nenhum modelo selecionado. Abra as Configurações → Personalização e escolha um modelo.');
    return;
  }

  // Adiciona a mensagem do usuário (com anexos) ao histórico persistente do chat
  const userMsg = { role: 'user', content: userPrompt };
  if (attachments && attachments.length) userMsg.attachments = attachments;
  chat.messages.push(userMsg);
  renderUserMessage(userPrompt, attachments, chat.messages.length - 1);

  await runAgent();
}

// Roda o loop do agente sobre o histórico atual (usado por envio novo e por regeneração)
async function runAgent() {
  const chat = activeChat();
  if (!state.settings.model) {
    appendError('Nenhum modelo selecionado. Abra as Configurações → Personalização e escolha um modelo.');
    return;
  }

  isRunning = true;
  stopRequested = false;
  updateInputState();

  try {
    await agentTurns(chat);
  } catch (err) {
    hideTyping();
    appendError(`Erro inesperado no agente: ${err.message}`);
    console.error(err);
  } finally {
    // Garante que o input SEMPRE destrave, mesmo se algo estourar no meio do loop
    isRunning = false;
    updateInputState();
    await persist();
  }
}

// Chamada em STREAMING (SSE): dispara os callbacks conforme o texto chega e
// retorna a mensagem final montada (content, reasoning_content, tool_calls) + usage.
async function streamChatCompletion({ apiUrl, apiKey, payload, signal, onContent, onReasoning }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST', headers, signal,
    body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${truncate(body, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '', reasoning = '';
  const toolAcc = [];
  let usage = null, finishReason = null, aborted = false, apiError = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // guarda a última linha (possivelmente incompleta)
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch (e) { continue; }
        if (json.error) { apiError = json.error.message || JSON.stringify(json.error); continue; }
        if (json.usage) usage = json.usage;
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning_content) { reasoning += delta.reasoning_content; onReasoning && onReasoning(reasoning); }
        if (delta.content) { content += delta.content; onContent && onContent(content); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolAcc[i]) toolAcc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolAcc[i].id = tc.id;
            if (tc.function && tc.function.name) toolAcc[i].function.name = tc.function.name;
            if (tc.function && tc.function.arguments) toolAcc[i].function.arguments += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') aborted = true;
    else throw err;
  }

  const tool_calls = toolAcc.filter(Boolean);
  return {
    message: { role: 'assistant', content, reasoning_content: reasoning, tool_calls: tool_calls.length ? tool_calls : undefined },
    usage, finishReason, aborted, apiError
  };
}

// Bolha de agente vazia para receber texto em streaming; retorna o .md-body
function createLiveAgentBody() {
  const chatBox = document.getElementById('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message agent streaming';
  const body = document.createElement('div');
  body.className = 'md-body';
  msgDiv.appendChild(body);
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
  return body;
}

// Bloco de raciocínio aberto para streaming; retorna { details, body }
function createLiveReasoning() {
  const chatBox = document.getElementById('chat-box');
  const details = document.createElement('details');
  details.className = 'reasoning';
  details.open = true;
  const summary = document.createElement('summary');
  summary.innerText = 'Raciocínio do modelo (pensando…)';
  const body = document.createElement('div');
  body.className = 'reasoning-body';
  details.appendChild(summary);
  details.appendChild(body);
  chatBox.appendChild(details);
  chatBox.scrollTop = chatBox.scrollHeight;
  return { details, summary, body };
}

// Executa o ciclo de raciocínio/ferramentas até o modelo parar de chamar ferramentas
async function agentTurns(chat) {
  const { apiUrl, model, apiKey, temperature, topP, maxTokens, noThink } = state.settings;

  let systemContent =
    `Você é um assistente de desenvolvimento com acesso direto aos arquivos do projeto local. ` +
    `O diretório de trabalho atual é: ${chat.path}. ` +
    `Use as ferramentas fornecidas para interagir com o ambiente. ` +
    `Responda em português. Quando a tarefa estiver concluída, responda ao usuário sem chamar mais ferramentas.`;
  if (noThink) systemContent += ' /no_think';

  await persist();

  let iterations = 0;

  while (iterations < MAX_LOOP_ITERATIONS) {
    if (stopRequested) break;
    iterations++;
    showTyping();

    // Elementos de streaming (criados sob demanda quando o primeiro token chega)
    let liveBody = null, liveReason = null;
    const onReasoning = (full) => {
      hideTyping();
      if (!liveReason) liveReason = createLiveReasoning();
      liveReason.body.innerText = full;
      scrollChat();
    };
    const onContent = (full) => {
      hideTyping();
      if (!liveBody) liveBody = createLiveAgentBody();
      liveBody.innerText = full; // texto puro enquanto digita; markdown ao finalizar
      scrollChat();
    };

    let result;
    abortController = new AbortController();
    try {
      result = await streamChatCompletion({
        apiUrl, apiKey,
        payload: {
          model,
          messages: [{ role: 'system', content: systemContent }, ...toApiMessages(chat.messages)],
          tools, tool_choice: 'auto', temperature, top_p: topP, max_tokens: maxTokens
        },
        signal: abortController.signal,
        onContent, onReasoning
      });
    } catch (err) {
      hideTyping();
      appendError(`Falha na requisição: ${err.message}`);
      break;
    } finally {
      abortController = null;
    }

    hideTyping();

    if (result.apiError) {
      appendError(`Erro da API: ${result.apiError}`);
      break;
    }

    trackUsage(result.usage);
    const message = result.message;
    const aborted = result.aborted || stopRequested;

    // Recolhe o bloco de raciocínio ao terminar
    if (liveReason) { liveReason.summary.innerText = 'Raciocínio do modelo'; liveReason.details.open = false; }

    // Se foi interrompido, NÃO guarda tool_calls (ficariam órfãos, sem resposta → erro no próximo turno)
    const hasContent = !!(message.content && message.content.trim());
    const stored = { role: 'assistant', content: message.content || '' };
    if (!aborted && message.tool_calls && message.tool_calls.length > 0) stored.tool_calls = message.tool_calls;

    if (hasContent || stored.tool_calls) {
      chat.messages.push(stored);
      const assistantIndex = chat.messages.length - 1;
      if (hasContent) {
        // Finaliza a bolha: re-renderiza como markdown e adiciona o botão de regenerar
        if (liveBody) {
          renderMarkdownInto(liveBody, message.content);
          liveBody.parentElement.classList.remove('streaming');
          attachMsgAction(liveBody.parentElement, 'regenerate', assistantIndex);
        } else {
          appendMessage(message.content, 'agent', assistantIndex);
        }
        maybeRenameChat(chat);
      } else if (liveBody) {
        liveBody.parentElement.remove();
      }
    } else if (liveBody) {
      liveBody.parentElement.remove(); // nada de útil: descarta a bolha
    }

    // Parada solicitada durante o stream
    if (aborted) {
      logSystem('Geração interrompida pelo usuário.');
      break;
    }

    // Sem chamadas de ferramenta → o agente terminou
    if (!message.tool_calls || message.tool_calls.length === 0) {
      break;
    }

    // Executa cada ferramenta solicitada
    for (const toolCall of message.tool_calls) {
      const fn = toolCall && toolCall.function;
      const name = (fn && fn.name) || '';
      let result;

      if (!name) {
        // Modelos quantizados às vezes emitem tool_calls malformados
        result = JSON.stringify({ error: 'tool_call malformado (sem nome de função)' });
        appendToolLog(`⚠ tool_call ignorado (malformado)`);
      } else {
        let args = {};
        try {
          args = fn.arguments ? JSON.parse(fn.arguments) : {};
        } catch (e) {
          args = {};
          logSystem(`Argumentos inválidos para ${name}, usando vazio.`);
        }
        const card = appendToolCall(name, args);
        result = await runTool(name, args, chat.path);
        fillToolResult(card, name, result);
      }

      chat.messages.push({
        role: 'tool',
        tool_call_id: toolCall && toolCall.id,
        name: name || 'unknown',
        content: result
      });
    }

    await persist();
  }

  if (iterations >= MAX_LOOP_ITERATIONS) {
    appendError(`Trava de segurança: ${MAX_LOOP_ITERATIONS} iterações seguidas. Se ainda precisava continuar, envie "continue".`);
  }
}

// Monta o payload para o servidor: remove reasoning_content e expande anexos no conteúdo do usuário
function toApiMessages(messages) {
  return messages.map(m => {
    const copy = { role: m.role };
    if (m.role === 'user' && m.attachments && m.attachments.length) {
      copy.content = buildAttachmentBlock(m.attachments) + (m.content || '');
    } else if (m.content !== undefined) {
      copy.content = m.content;
    }
    if (m.tool_calls) copy.tool_calls = m.tool_calls;
    if (m.tool_call_id) copy.tool_call_id = m.tool_call_id;
    if (m.name) copy.name = m.name;
    return copy;
  });
}

function buildAttachmentBlock(attachments) {
  return attachments.map(a => {
    if (a.binary) return `[Arquivo anexado: ${a.name} — binário (${fmtSize(a.size)}), conteúdo não incluído]`;
    const suffix = a.truncated ? ` (truncado em ${fmtSize(a.content.length)})` : '';
    return `[Arquivo anexado: ${a.name}${suffix}]\n\`\`\`\n${a.content}\n\`\`\``;
  }).join('\n\n') + '\n\n';
}

// ---- Importação de arquivos para o chat ----
let pendingAttachments = [];
const ATTACH_MAX = 120 * 1024; // ~120 KB de texto por arquivo
const TEXT_EXT = /\.(txt|md|markdown|js|mjs|cjs|ts|jsx|tsx|json|jsonc|html?|css|scss|sass|less|py|rb|go|rs|java|kt|c|h|hpp|cpp|cc|cs|php|sh|bash|zsh|zig|yml|yaml|toml|ini|cfg|conf|env|xml|sql|csv|tsv|log|vue|svelte|swift|dart|lua|r|pl|pm|ex|exs|erl|hs|clj|gradle|properties)$/i;
const TEXT_NAME = /^(dockerfile|makefile|\.gitignore|\.env|readme|license|procfile)$/i;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readFileAsText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    const looksText = TEXT_EXT.test(file.name) || TEXT_NAME.test(file.name) ||
      (file.type && (file.type.startsWith('text/') || file.type === 'application/json' || file.type.includes('xml')));
    if (!looksText) {
      pendingAttachments.push({ name: file.name, size: file.size, binary: true, content: '' });
      continue;
    }
    let content = await readFileAsText(file);
    if (content == null) {
      pendingAttachments.push({ name: file.name, size: file.size, binary: true, content: '' });
      continue;
    }
    let truncated = false;
    if (content.length > ATTACH_MAX) { content = content.slice(0, ATTACH_MAX); truncated = true; }
    pendingAttachments.push({ name: file.name, size: file.size, content, truncated });
  }
  renderAttachments();
}

function renderAttachments() {
  const el = document.getElementById('attachments');
  if (!el) return;
  el.innerHTML = '';
  el.style.display = pendingAttachments.length ? 'flex' : 'none';
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip' + (a.binary ? ' binary' : '');
    const icon = document.createElement('span');
    icon.className = 'attach-icon';
    icon.innerText = a.binary ? '🗎' : '📄';
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.innerText = a.name;
    name.title = a.name;
    const size = document.createElement('span');
    size.className = 'attach-size';
    size.innerText = fmtSize(a.size) + (a.truncated ? ' • truncado' : '') + (a.binary ? ' • binário' : '');
    const rm = document.createElement('button');
    rm.className = 'attach-remove';
    rm.innerText = '×';
    rm.title = 'Remover';
    rm.addEventListener('click', () => { pendingAttachments.splice(i, 1); renderAttachments(); });
    chip.append(icon, name, size, rm);
    el.appendChild(chip);
  });
}

function maybeRenameChat(chat) {
  if (chat.name === 'Novo Chat' || chat.name === 'Chat Inicial') {
    const firstUser = chat.messages.find(m => m.role === 'user');
    if (firstUser) {
      let base = (firstUser.content || '').trim();
      if (!base && firstUser.attachments && firstUser.attachments.length) {
        base = '📎 ' + firstUser.attachments[0].name;
      }
      if (!base) return;
      chat.name = base.slice(0, 30) + (base.length > 30 ? '…' : '');
      renderChatList();
    }
  }
}

// --------------------------------------------------------------------------
//  Rastreamento real de uso de tokens
// --------------------------------------------------------------------------
function trackUsage(usage) {
  if (!usage) return;
  state.usage.prompt += usage.prompt_tokens || 0;
  state.usage.completion += usage.completion_tokens || 0;
  state.usage.requests += 1;
  state.usage.lastTotal = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
  state.usage.history.push(usage.completion_tokens || 0);
  if (state.usage.history.length > 12) state.usage.history.shift();
  renderUsage();
}

function renderUsage() {
  const u = state.usage;
  document.getElementById('usage-prompt').innerText = u.prompt.toLocaleString('pt-BR');
  document.getElementById('usage-completion').innerText = u.completion.toLocaleString('pt-BR');
  document.getElementById('usage-total').innerText = (u.prompt + u.completion).toLocaleString('pt-BR');
  document.getElementById('usage-requests').innerText = u.requests;

  // Barra de contexto usado na última requisição
  const ctx = state.modelCtx || 0;
  const pct = ctx > 0 ? Math.min(100, Math.round((u.lastTotal / ctx) * 100)) : 0;
  document.getElementById('ctx-label').innerText = `${u.lastTotal} / ${ctx || '?'} tkn`;
  document.getElementById('ctx-percent').innerText = `${pct}%`;
  document.getElementById('ctx-fill').style.width = `${pct}%`;

  // Medidor de contexto sempre visível no cabeçalho
  const ctxText = `${u.lastTotal.toLocaleString('pt-BR')} / ${ctx ? ctx.toLocaleString('pt-BR') : '?'} tkn`;
  document.getElementById('hdr-ctx-text').innerText = ctxText;
  document.getElementById('hdr-ctx-fill').style.width = `${pct}%`;
  const pill = document.getElementById('ctx-pill');
  pill.classList.toggle('warn', pct >= 70 && pct < 90);
  pill.classList.toggle('danger', pct >= 90);

  // Gráfico de barras de tokens gerados
  const chart = document.getElementById('usage-chart');
  chart.innerHTML = '';
  const max = Math.max(1, ...u.history);
  if (u.history.length === 0) {
    chart.innerHTML = '<span class="chart-label">Sem dados ainda.</span>';
    return;
  }
  u.history.forEach((val, i) => {
    const col = document.createElement('div');
    col.className = 'chart-column';
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.style.height = `${Math.round((val / max) * 100)}%`;
    bar.title = `${val} tokens`;
    const label = document.createElement('span');
    label.className = 'chart-label';
    label.innerText = `#${i + 1}`;
    col.appendChild(bar);
    col.appendChild(label);
    chart.appendChild(col);
  });
}

// --------------------------------------------------------------------------
//  Busca de modelos e informações reais do endpoint
// --------------------------------------------------------------------------
async function fetchModels() {
  const status = document.getElementById('info-model-status');
  const select = document.getElementById('model-name');
  const apiUrl = document.getElementById('api-url').value.trim() || state.settings.apiUrl;

  status.innerText = 'Consultando endpoint...';
  try {
    const headers = {};
    if (state.settings.apiKey) headers['Authorization'] = `Bearer ${state.settings.apiKey}`;
    const res = await fetch(`${apiUrl}/models`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const models = json.data || [];

    if (models.length === 0) throw new Error('Nenhum modelo retornado.');

    select.innerHTML = '';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.innerText = shortModelName(m.id);
      select.appendChild(opt);
    });

    // Mantém a seleção salva se ainda existir; senão pega o primeiro
    if (state.settings.model && models.some(m => m.id === state.settings.model)) {
      select.value = state.settings.model;
    } else {
      select.value = models[0].id;
      state.settings.model = models[0].id;
    }

    updateModelInfo(models.find(m => m.id === select.value) || models[0]);
    status.innerText = `${models.length} modelo(s) disponível(is).`;
  } catch (err) {
    status.innerText = `Não foi possível carregar modelos de ${apiUrl}/models — ${err.message}`;
    select.innerHTML = '<option value="">(indisponível)</option>';
  }
}

function shortModelName(id) {
  // Caminhos completos de gguf ficam enormes; mostra só o nome do arquivo
  const parts = id.split(/[\\/]/);
  return parts[parts.length - 1] || id;
}

function updateModelInfo(model) {
  const meta = (model && model.meta) || {};
  document.getElementById('info-model-name').innerText = shortModelName(model.id);
  document.getElementById('info-model-quant').innerText = meta.ftype || '—';
  document.getElementById('info-model-ctx').innerText = meta.n_ctx
    ? `${meta.n_ctx.toLocaleString('pt-BR')} tkn` : '—';
  document.getElementById('info-model-size').innerText = meta.size
    ? `${(meta.size / 1e9).toFixed(2)} GB` : '—';
  document.getElementById('info-model-params').innerText = meta.n_params
    ? `${(meta.n_params / 1e9).toFixed(2)} B` : '—';
  document.getElementById('info-model-owner').innerText = model.owned_by || '—';
  state.modelCtx = meta.n_ctx || 0;
  renderUsage();
}

// --------------------------------------------------------------------------
//  Configurações (formulário do modal)
// --------------------------------------------------------------------------
function applySettingsToForm() {
  const s = state.settings;
  document.getElementById('api-url').value = s.apiUrl;
  document.getElementById('api-key').value = s.apiKey;
  document.getElementById('range-temp').value = s.temperature;
  document.getElementById('range-temp').nextElementSibling.innerText = s.temperature;
  document.getElementById('range-topp').value = s.topP;
  document.getElementById('range-topp').nextElementSibling.innerText = s.topP;
  document.getElementById('input-maxtokens').value = s.maxTokens;
  document.getElementById('input-cmdtimeout').value = s.cmdTimeout;
  document.getElementById('check-nothink').checked = s.noThink;
}

function readSettingsFromForm() {
  state.settings.apiUrl = document.getElementById('api-url').value.trim() || DEFAULT_SETTINGS.apiUrl;
  state.settings.apiKey = document.getElementById('api-key').value.trim();
  state.settings.model = document.getElementById('model-name').value;
  state.settings.temperature = parseFloat(document.getElementById('range-temp').value);
  state.settings.topP = parseFloat(document.getElementById('range-topp').value);
  state.settings.maxTokens = parseInt(document.getElementById('input-maxtokens').value, 10) || DEFAULT_SETTINGS.maxTokens;
  state.settings.cmdTimeout = parseInt(document.getElementById('input-cmdtimeout').value, 10) || DEFAULT_SETTINGS.cmdTimeout;
  state.settings.noThink = document.getElementById('check-nothink').checked;
}

// --------------------------------------------------------------------------
//  Ligação de eventos da interface
// --------------------------------------------------------------------------
function wireEvents() {
  // Selecionar pasta de trabalho (diálogo nativo real do Electron)
  document.getElementById('btn-select-folder').addEventListener('click', async () => {
    const folderPath = await window.electronAPI.selectFolder();
    if (folderPath) {
      activeChat().path = folderPath;
      document.getElementById('selected-path').innerText = folderPath;
      logSystem(`Workspace definido para: ${folderPath}`);
      updateInputState();
      persist();
    }
  });

  // Enviar mensagem (com anexos, se houver)
  const inputEl = document.getElementById('user-input');
  const autoGrow = () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  };
  const sendMessage = () => {
    if (isRunning) return;
    const prompt = inputEl.value.trim();
    if (!prompt && pendingAttachments.length === 0) return;
    const attachments = pendingAttachments.slice();
    inputEl.value = '';
    autoGrow();
    pendingAttachments = [];
    renderAttachments();
    submitUserMessage(prompt, attachments);
  };
  // Botão único: envia quando ocioso, para a geração quando o agente está rodando
  document.getElementById('btn-send').addEventListener('click', () => {
    if (isRunning) stopAgent();
    else sendMessage();
  });
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Anexar arquivos: botão + seletor nativo
  const fileInput = document.getElementById('file-input');
  document.getElementById('btn-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

  // Anexar arquivos: arrastar-e-soltar sobre a área principal
  const dropZone = document.querySelector('.main-content');
  const overlay = document.getElementById('drop-overlay');
  let dragDepth = 0;
  dropZone.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault(); dragDepth++; overlay.classList.add('active');
  });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); });
  dropZone.addEventListener('dragleave', (e) => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.remove('active');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; overlay.classList.remove('active');
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  // Novo chat
  document.querySelector('.btn-new-chat').addEventListener('click', () => {
    createChat('Novo Chat');
    renderChatList();
    renderActiveChat();
    persist();
  });

  // Abas do modal
  const tabButtons = document.querySelectorAll('.nav-tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabPanels.forEach(panel => panel.classList.remove('active'));
      button.classList.add('active');
      document.getElementById(button.getAttribute('data-tab')).classList.add('active');
    });
  });

  // Abrir/fechar modal
  const modal = document.getElementById('settings-modal');
  document.getElementById('btn-open-settings').addEventListener('click', () => {
    applySettingsToForm();
    modal.classList.add('active');
    fetchModels();
  });
  const closeModal = () => modal.classList.remove('active');
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-save-settings').addEventListener('click', () => {
    readSettingsFromForm();
    persist();
    closeModal();
    logSystem('Configurações salvas.');
  });

  // Recarregar modelos manualmente
  document.getElementById('btn-refresh-models').addEventListener('click', fetchModels);

  // Atualiza a info do modelo ao trocar a seleção
  document.getElementById('model-name').addEventListener('change', (e) => {
    state.settings.model = e.target.value;
  });
}

// --------------------------------------------------------------------------
//  Inicialização
// --------------------------------------------------------------------------
async function init() {
  await loadPersisted();
  wireEvents();
  renderChatList();
  renderActiveChat();
  renderAttachments();
  renderUsage();
  // Tenta descobrir os modelos do endpoint padrão já na abertura
  fetchModels();
}

init();
