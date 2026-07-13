import { APP_NAME, DEFAULT_SETTINGS, MAX_LOOP_ITERATIONS, MAX_TOOL_RESULT_CHARS, system_prompt } from "./constants.js";

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
  if (pendingConfirm) resolveConfirm('reject'); // fecha o modal de confirmação, se aberto
  if (abortController) { try { abortController.abort(); } catch (e) { } }
}

// ---- Confirmação de execução (modo manual) ----
let pendingConfirm = null;
const CONFIRM_TOOLS = { execute_command: true, delete_file: true };

// Retorna 'approve' | 'reject' (e pode alternar para 'auto' via "sempre permitir")
async function maybeConfirmTool(name, args) {
  if (stopRequested) return 'reject'; // usuário já pediu para parar
  if (!CONFIRM_TOOLS[name] || state.settings.execMode !== 'manual') return 'approve';
  const decision = await askExecConfirm(name, args);
  if (decision === 'always') {
    state.settings.execMode = 'auto';
    updateExecModeUI();
    persist();
    return 'approve';
  }
  return decision; // 'approve' | 'reject'
}

function askExecConfirm(name, args) {
  return new Promise((resolve) => {
    pendingConfirm = { resolve };
    showConfirmModal(name, args);
  });
}

function resolveConfirm(decision) {
  hideConfirmModal();
  if (pendingConfirm) {
    const done = pendingConfirm.resolve;
    pendingConfirm = null;
    done(decision);
  }
}

function showConfirmModal(name, args) {
  const modal = document.getElementById('confirm-modal');
  const label = document.getElementById('confirm-label');
  const cmd = document.getElementById('confirm-command');
  if (name === 'execute_command') {
    label.innerText = 'Executar comando no terminal?';
    cmd.innerText = '$ ' + (args.command || '');
  } else if (name === 'delete_file') {
    label.innerText = 'Apagar arquivo?';
    cmd.innerText = '🗑 ' + (args.filename || '');
  } else {
    label.innerText = 'Confirmar ação?';
    cmd.innerText = JSON.stringify(args);
  }
  modal.classList.add('active');
  const ok = document.getElementById('confirm-approve');
  if (ok) ok.focus();
}

function hideConfirmModal() {
  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.remove('active');
}

function updateExecModeUI() {
  document.querySelectorAll('#exec-mode .exec-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.settings.execMode);
  });
}

// ---- Painel de processos ativos (etapa 4) ----
let processList = [];
const procOutputTimers = {}; // pid -> intervalId dos "Ver saída" abertos

async function refreshProcesses() {
  try { processList = await window.electronAPI.listProcesses(); }
  catch (e) { processList = []; }
  const running = processList.filter(p => p.status === 'running').length;
  const badge = document.getElementById('proc-badge');
  const btn = document.getElementById('btn-processes');
  if (badge) { badge.innerText = running; badge.style.display = running > 0 ? 'flex' : 'none'; }
  if (btn) btn.classList.toggle('has-active', running > 0);
  const modal = document.getElementById('processes-modal');
  if (modal && modal.classList.contains('active')) renderProcessList();
}

// Guarda as linhas já criadas por PID para reaproveitá-las (NÃO recriar a cada refresh,
// senão o <pre> de saída aberto é destruído e o polling perde o alvo — bug do "some").
const procRows = {}; // pid -> { row, dot, meta, out, viewBtn, stopBtn }

function buildProcRow(p) {
  const row = document.createElement('div');
  row.className = 'proc-row';

  const head = document.createElement('div');
  head.className = 'proc-head';
  const dot = document.createElement('span');
  const cmd = document.createElement('span');
  cmd.className = 'proc-cmd'; cmd.innerText = p.command; cmd.title = p.command;
  head.append(dot, cmd);

  const meta = document.createElement('div');
  meta.className = 'proc-meta';

  const out = document.createElement('pre');
  out.className = 'proc-output'; out.style.display = 'none';

  const actions = document.createElement('div');
  actions.className = 'proc-actions';
  const viewBtn = document.createElement('button');
  viewBtn.className = 'proc-btn'; viewBtn.innerText = 'Ver saída';
  viewBtn.addEventListener('click', () => toggleProcOutput(p.pid, out, viewBtn));
  const stopBtn = document.createElement('button');
  stopBtn.className = 'proc-btn danger'; stopBtn.innerText = 'Parar';
  stopBtn.addEventListener('click', () => stopProc(p.pid));
  actions.append(viewBtn, stopBtn);

  row.append(head, meta, actions, out);
  return { row, dot, meta, out, viewBtn, stopBtn };
}

function renderProcessList() {
  const container = document.getElementById('proc-list');
  if (!container) return;

  if (!processList.length) {
    container.innerHTML = '';
    for (const k in procRows) delete procRows[k];
    const empty = document.createElement('div');
    empty.className = 'proc-empty';
    empty.innerText = 'Nenhum processo foi iniciado nesta sessão.';
    container.appendChild(empty);
    return;
  }
  const placeholder = container.querySelector('.proc-empty');
  if (placeholder) placeholder.remove();

  const seen = new Set();
  const sorted = [...processList].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1));
  for (const p of sorted) {
    seen.add(String(p.pid));
    let r = procRows[p.pid];
    if (!r) { r = buildProcRow(p); procRows[p.pid] = r; }
    // atualiza no lugar (sem destruir o <pre> de saída que possa estar aberto)
    r.dot.className = 'proc-status ' + (p.status === 'running' ? 'running' : p.status === 'stopped' ? 'stopped' : 'exited');
    r.meta.innerText = `PID ${p.pid} · ${p.status} · ${p.uptimeSec}s`;
    r.stopBtn.disabled = p.status !== 'running';
    container.appendChild(r.row); // (re)posiciona mantendo running primeiro
  }
  // remove as linhas cujos processos sumiram do registro
  for (const pid in procRows) {
    if (!seen.has(pid)) {
      if (procOutputTimers[pid]) { clearInterval(procOutputTimers[pid]); delete procOutputTimers[pid]; }
      procRows[pid].row.remove();
      delete procRows[pid];
    }
  }
}

async function toggleProcOutput(pid, outEl, btn) {
  if (procOutputTimers[pid]) { // já aberto → fecha
    clearInterval(procOutputTimers[pid]); delete procOutputTimers[pid];
    outEl.style.display = 'none'; btn.innerText = 'Ver saída';
    return;
  }
  outEl.style.display = 'block'; btn.innerText = 'Ocultar saída';
  const poll = async () => {
    const res = await window.electronAPI.readProcessOutput(pid);
    if (res && res.success) {
      const txt = [(res.stdout || ''), (res.stderr || '')].filter(x => x.trim()).join('\n');
      const atBottom = outEl.scrollHeight - outEl.scrollTop - outEl.clientHeight < 30;
      outEl.innerText = txt || '(sem saída ainda)';
      if (atBottom) outEl.scrollTop = outEl.scrollHeight;
    } else {
      outEl.innerText = (res && res.error) || 'processo não encontrado';
    }
  };
  await poll();
  procOutputTimers[pid] = setInterval(poll, 1000); // acompanha a saída em tempo real
}

async function stopProc(pid) {
  if (procOutputTimers[pid]) { clearInterval(procOutputTimers[pid]); delete procOutputTimers[pid]; }
  await window.electronAPI.stopProcess(pid);
  await refreshProcesses();
}

function openProcessesModal() {
  document.getElementById('processes-modal').classList.add('active');
  refreshProcesses();
}

function closeProcessesModal() {
  document.getElementById('processes-modal').classList.remove('active');
  for (const pid in procOutputTimers) { clearInterval(procOutputTimers[pid]); delete procOutputTimers[pid]; }
}

// "Grudar no fim": só acompanha o final se o usuário já estiver perto do fim.
// Se ele rolar para cima (para ler), paramos de puxar — mesmo durante o streaming.
let stickToBottom = true;
function scrollChat() {
  if (!stickToBottom) return;
  const cb = document.getElementById('chat-box');
  cb.scrollTop = cb.scrollHeight;
}
// Força ir ao fim e reativa o acompanhamento (ex.: ao enviar mensagem ou trocar de chat)
function forceScrollBottom() {
  stickToBottom = true;
  const cb = document.getElementById('chat-box');
  if (cb) cb.scrollTop = cb.scrollHeight;
}

// Atualiza o título da janela: "Pofuserver Coder Studio — <status>" (ou só o nome quando ocioso)
function setAppTitle(status) {
  const title = status ? `${APP_NAME} — ${status}` : APP_NAME;
  document.title = title;
  if (window.electronAPI && window.electronAPI.setTitle) window.electronAPI.setTitle(title);
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
    nameSpan.title = 'Duplo clique para renomear';
    nameSpan.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRenameChat(id, nameSpan); });
    item.appendChild(nameSpan);

    const actions = document.createElement('div');
    actions.className = 'chat-item-actions';

    const rename = document.createElement('button');
    rename.className = 'chat-action';
    rename.title = 'Renomear chat';
    rename.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    rename.addEventListener('click', (e) => { e.stopPropagation(); beginRenameChat(id, nameSpan); });
    actions.appendChild(rename);

    const del = document.createElement('button');
    del.className = 'chat-action chat-delete';
    del.title = 'Apagar chat';
    del.innerText = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(id);
    });
    actions.appendChild(del);
    item.appendChild(actions);

    item.addEventListener('click', () => switchChat(id));
    container.appendChild(item);
  });
}

// Renomeia um chat com edição inline no próprio item da lista
function beginRenameChat(id, nameSpan) {
  const chat = state.chats[id];
  if (!chat) return;
  const input = document.createElement('input');
  input.className = 'chat-rename-input';
  input.value = chat.name;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) { chat.name = v; persist(); }
    }
    renderChatList();
    if (id === state.activeChatId) document.getElementById('active-chat-title').innerText = state.chats[id].name;
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Renomeia o chat ativo pelo título do cabeçalho (duplo clique)
function renameActiveChat() {
  const titleEl = document.getElementById('active-chat-title');
  const chat = activeChat();
  if (!chat || titleEl.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'chat-rename-input header-rename';
  input.value = chat.name;
  titleEl.innerHTML = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) { const v = input.value.trim(); if (v) { chat.name = v; persist(); } }
    titleEl.innerText = chat.name;
    renderChatList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
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
  stickToBottom = true; // ao (re)carregar/trocar de chat, começa acompanhando o fim

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
      if (msg.content) {
        const div = appendMessage(msg.content, 'agent', i);
        if (msg.stats) renderMsgStats(div, msg.stats);
      }
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

  // Todo link do Markdown deve abrir no navegador padrão do sistema, nunca dentro do app.
  // target="_blank" faz o clique passar pelo setWindowOpenHandler do main.js (que abre
  // externamente e nega a navegação interna).
  container.querySelectorAll('a[href]').forEach(a => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });

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
  scrollChat();
  return msgDiv;
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
  scrollChat();
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
  scrollChat();
}

function logSystem(text) {
  const chatBox = document.getElementById('chat-box');
  const logDiv = document.createElement('div');
  logDiv.className = 'system-log';
  logDiv.innerText = `[SISTEMA]: ${text}`;
  chatBox.appendChild(logDiv);
  scrollChat();
}

function appendToolLog(text) {
  const chatBox = document.getElementById('chat-box');
  const div = document.createElement('div');
  div.className = 'tool-log';
  div.innerText = text;
  chatBox.appendChild(div);
  scrollChat();
}

// ---- Cards de ferramenta (exibição amigável, sem JSON cru) ----
const TOOL_META = {
  list_files: { icon: '📁', label: 'Listar arquivos' },
  read_file: { icon: '📄', label: 'Ler arquivo' },
  write_file: { icon: '✏️', label: 'Escrever arquivo' },
  create_directory: { icon: '📂', label: 'Criar pasta' },
  delete_file: { icon: '🗑️', label: 'Apagar arquivo' },
  execute_command: { icon: '⌘', label: 'Terminal' },
  read_process_output: { icon: '📜', label: 'Saída do processo' },
  list_processes: { icon: '📋', label: 'Processos' },
  stop_process: { icon: '⛔', label: 'Parar processo' },
  web_search: { icon: '🔎', label: 'Buscar na web' },
  fetch_url: { icon: '🌐', label: 'Ler página' }
};

// Resumo legível dos argumentos da chamada
function summarizeToolCall(name, args) {
  args = args || {};
  switch (name) {
    case 'execute_command': return '$ ' + (args.command || '');
    case 'read_file':
    case 'write_file':
    case 'delete_file': return args.filename || '';
    case 'create_directory': return (args.dirname || '') + '/';
    case 'list_files': return args.subpath ? args.subpath + '/' : './';
    case 'read_process_output':
    case 'stop_process': return 'PID ' + (args.pid ?? '?');
    case 'list_processes': return '';
    case 'web_search': return '🔎 ' + (args.query || '');
    case 'fetch_url': return args.url || '';
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
    case 'write_file': return data.success ? '✓ Arquivo salvo' : (data.error || resultStr);
    case 'create_directory': return data.success ? '✓ Pasta criada' : (data.error || resultStr);
    case 'delete_file': return data.success ? '✓ Arquivo apagado' : (data.error || resultStr);
    case 'stop_process': return data.success ? `✓ Processo ${data.pid} encerrado` : (data.error || resultStr);
    case 'web_search':
      if (!data.success) return `⚠ ${data.error || 'falha na busca'}`;
      if (!data.results || !data.results.length) return '(nenhum resultado)';
      return data.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
    case 'fetch_url':
      if (!data.success) return `⚠ ${data.error || 'falha ao baixar'}`;
      return `[${data.status}] ${data.url}\n\n${(data.content || '').slice(0, 1000)}${(data.content || '').length > 1000 ? '…' : ''}`;
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
  scrollChat();
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
  scrollChat();
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
  scrollChat();
}

function appendError(text) {
  const chatBox = document.getElementById('chat-box');
  const div = document.createElement('div');
  div.className = 'error-msg';
  div.innerText = `⚠ ${text}`;
  chatBox.appendChild(div);
  scrollChat();
}

function showTyping() {
  const chatBox = document.getElementById('chat-box');
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.id = 'typing-indicator';
  div.innerHTML = '<span></span><span></span><span></span>';
  chatBox.appendChild(div);
  scrollChat();
}

function hideTyping() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function truncate(str, max) {
  if (typeof str !== 'string') str = String(str);
  return str.length > max ? str.slice(0, max) + `\n… (truncado, ${str.length} caracteres)` : str;
}

// Recorta pelo MEIO preservando início e fim (o erro costuma estar no fim da saída)
function clipMiddle(str, max) {
  str = String(str || '');
  if (str.length <= max) return str;
  const head = Math.floor(max * 0.35), tail = max - head;
  return str.slice(0, head) + `\n…[${str.length - max} caracteres omitidos]…\n` + str.slice(-tail);
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
      name: 'create_directory',
      description: 'Cria uma pasta (e as pastas pai necessárias) no workspace.',
      parameters: {
        type: 'object',
        properties: {
          dirname: { type: 'string', description: 'Caminho relativo da pasta a criar (ex: src/components)' }
        },
        required: ['dirname']
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

// Ferramentas de web — incluídas só quando a busca na web está ativada nas configurações
const webTools = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Pesquisa na web (DuckDuckGo) e retorna uma lista de resultados (título, URL e resumo). ' +
        'Use para obter informações atuais, documentação ou referências que você não conhece.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termos de busca' },
          max_results: { type: 'number', description: 'Quantidade de resultados (1-10, padrão 5)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Baixa uma página da web e retorna seu conteúdo em texto legível. ' +
        'Use para ler o conteúdo de um resultado retornado por web_search.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL completa da página a ler' }
        },
        required: ['url']
      }
    }
  }
];

// Monta a lista de ferramentas disponíveis conforme as configurações
function activeTools() {
  return state.settings.webSearch ? [...tools, ...webTools] : tools;
}

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
    if (name === 'create_directory') {
      const res = await window.electronAPI.createDirectory(`${workspace}/${args.dirname}`);
      return JSON.stringify(res);
    }
    if (name === 'delete_file') {
      const res = await window.electronAPI.deleteFile(`${workspace}/${args.filename}`);
      return JSON.stringify(res);
    }
    if (name === 'execute_command') {
      const timeoutMs = (state.settings.cmdTimeout || 25) * 1000;
      const res = await window.electronAPI.executeCommand(args.command, workspace, { timeoutMs });
      // Monta um resultado LIMITADO priorizando erro/exit/stderr (senão um stdout
      // gigante empurraria o motivo da falha para fora do limite e o modelo não o veria).
      const bounded = {
        command: res.command,
        finished: res.finished,
        backgrounded: res.backgrounded || undefined,
        pid: res.pid,
        reason: res.reason,
        exitCode: res.exitCode,
        error: res.error || undefined,
        note: res.note,
        stderr: clipMiddle(res.stderr || '', 2500) || undefined,
        stdout: clipMiddle(res.stdout || '', 3000) || undefined
      };
      return JSON.stringify(bounded);
    }
    if (name === 'read_process_output') {
      const res = await window.electronAPI.readProcessOutput(args.pid);
      if (res && res.success) {
        res.stderr = clipMiddle(res.stderr || '', 2500) || undefined;
        res.stdout = clipMiddle(res.stdout || '', 3000) || undefined;
      }
      return JSON.stringify(res);
    }
    if (name === 'list_processes') {
      const res = await window.electronAPI.listProcesses();
      return JSON.stringify(res);
    }
    if (name === 'stop_process') {
      const res = await window.electronAPI.stopProcess(args.pid);
      return JSON.stringify(res);
    }
    if (name === 'web_search') {
      const res = await window.electronAPI.webSearch(args.query, args.max_results || 5);
      return truncate(JSON.stringify(res), MAX_TOOL_RESULT_CHARS);
    }
    if (name === 'fetch_url') {
      const res = await window.electronAPI.fetchUrl(args.url, 8000);
      return truncate(JSON.stringify(res), MAX_TOOL_RESULT_CHARS);
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
  forceScrollBottom(); // ao enviar, volta ao fim e reativa o acompanhamento
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
  refreshModelContext(); // atualiza n_ctx/infos do modelo a cada requisição (não bloqueia)

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
    setAppTitle(''); // volta o título ao nome do app
    await persist();
    // Se o agente terminou deixando processos rodando, avisa (o usuário pode precisar encerrá-los)
    await refreshProcesses();
    const running = processList.filter(p => p.status === 'running').length;
    if (running > 0) {
      logSystem(`${running} processo(s) ainda em execução em segundo plano — veja/encerre no painel de processos (ícone no topo).`);
    }
  }
}

async function clearFinishedProcesses() {
  await window.electronAPI.clearFinishedProcesses();
  await refreshProcesses();
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
  const startedAt = performance.now();
  let firstTokenAt = 0; // tempo até o primeiro token (TTFT)

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
        if ((delta.reasoning_content || delta.content) && !firstTokenAt) firstTokenAt = performance.now();
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
  const endedAt = performance.now();
  const timing = {
    totalMs: endedAt - startedAt,
    ttftMs: firstTokenAt ? firstTokenAt - startedAt : 0,
    genMs: firstTokenAt ? endedAt - firstTokenAt : 0 // tempo de geração (após o 1º token)
  };
  return {
    message: { role: 'assistant', content, reasoning_content: reasoning, tool_calls: tool_calls.length ? tool_calls : undefined },
    usage, finishReason, aborted, apiError, timing
  };
}

// Calcula as métricas exibidas abaixo da resposta (velocidade, tokens, tempo)
function buildResponseStats(usage, timing) {
  if (!timing) return null;
  const completion = usage ? (usage.completion_tokens || 0) : 0;
  const genSec = timing.genMs > 0 ? timing.genMs / 1000 : 0;
  const tps = (completion > 0 && genSec > 0) ? completion / genSec : 0;
  return {
    tps: Math.round(tps * 10) / 10,
    completion,
    prompt: usage ? (usage.prompt_tokens || 0) : 0,
    total: usage ? (usage.total_tokens || 0) : 0,
    totalSec: Math.round((timing.totalMs / 1000) * 10) / 10,
    ttftSec: Math.round((timing.ttftMs / 1000) * 10) / 10
  };
}

// Renderiza a linha de métricas abaixo de uma bolha do agente
function renderMsgStats(msgDiv, stats) {
  if (!msgDiv || !stats) return;
  const parts = [];
  if (stats.tps > 0) parts.push(`${stats.tps} tok/s`);
  if (stats.completion > 0) parts.push(`${stats.completion} tokens gerados`);
  if (stats.totalSec > 0) parts.push(`${stats.totalSec}s`);
  if (stats.ttftSec > 0) parts.push(`${stats.ttftSec}s até 1º token`);
  if (stats.total > 0) parts.push(`${stats.total} tkn no contexto`);
  if (!parts.length) return;
  const bar = document.createElement('div');
  bar.className = 'msg-stats';
  bar.innerText = parts.join('  ·  ');
  msgDiv.appendChild(bar);
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
  scrollChat();
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
  scrollChat();
  return { details, summary, body };
}

// Executa o ciclo de raciocínio/ferramentas até o modelo parar de chamar ferramentas
async function agentTurns(chat) {
  const { apiUrl, model, apiKey, temperature, topP, maxTokens, noThink } = state.settings;

  let systemContent = system_prompt(chat.path, state.settings.webSearch);
  if (noThink) systemContent += ' /no_think';

  const toolset = activeTools();

  await persist();

  let iterations = 0;

  while (iterations < MAX_LOOP_ITERATIONS || !state.settings.safetyInteractions) {
    if (stopRequested) break;
    iterations++;
    showTyping();
    setAppTitle('pensando…');

    // Elementos de streaming (criados sob demanda quando o primeiro token chega)
    let liveBody = null, liveReason = null;
    const onReasoning = (full) => {
      hideTyping();
      setAppTitle('pensando…');
      if (!liveReason) liveReason = createLiveReasoning();
      liveReason.body.innerText = full;
      scrollChat();
    };
    const onContent = (full) => {
      hideTyping();
      setAppTitle('gerando resposta…');
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
          tools: toolset, tool_choice: 'auto', temperature, top_p: topP, max_tokens: maxTokens
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
    if (liveReason) { liveReason.summary.innerText = 'Raciocínio do modelo'; setTimeout(() => liveReason.details.open = false, 500) }

    // Se foi interrompido, NÃO guarda tool_calls (ficariam órfãos, sem resposta → erro no próximo turno)
    const hasContent = !!(message.content && message.content.trim());
    const stats = buildResponseStats(result.usage, result.timing);
    const stored = { role: 'assistant', content: message.content || '' };
    if (!aborted && message.tool_calls && message.tool_calls.length > 0) stored.tool_calls = message.tool_calls;

    if (hasContent || stored.tool_calls) {
      if (hasContent && stats) stored.stats = stats; // guarda métricas para reexibir no reload
      chat.messages.push(stored);
      const assistantIndex = chat.messages.length - 1;
      if (hasContent) {
        // Finaliza a bolha: re-renderiza como markdown, adiciona botão de regenerar e as métricas
        const bubble = liveBody ? liveBody.parentElement : null;
        if (liveBody) {
          renderMarkdownInto(liveBody, message.content);
          bubble.classList.remove('streaming');
          attachMsgAction(bubble, 'regenerate', assistantIndex);
          renderMsgStats(bubble, stats);
        } else {
          const div = appendMessage(message.content, 'agent', assistantIndex);
          renderMsgStats(div, stats);
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
        // Modo manual: pede confirmação para ações que executam/apagam
        const decision = await maybeConfirmTool(name, args);
        if (decision === 'reject') {
          result = JSON.stringify({ rejected: true, error: 'O usuário rejeitou esta ação. Não a repita; aguarde novas instruções ou proponha uma alternativa.' });
          fillToolResult(card, name, result);
          logSystem(`Ação rejeitada pelo usuário: ${(TOOL_META[name] && TOOL_META[name].label) || name}`);
        } else {
          setAppTitle(`executando: ${(TOOL_META[name] && TOOL_META[name].label) || name}`);
          result = await runTool(name, args, chat.path);
          fillToolResult(card, name, result);
          refreshProcesses(); // atualiza o painel de processos (pode ter subido/encerrado algo)
        }
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

  if (iterations >= MAX_LOOP_ITERATIONS && state.settings.safetyInteractions) appendError(`Trava de segurança: ${MAX_LOOP_ITERATIONS} iterações seguidas. Se ainda precisava continuar, envie "continue".`);
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

// Atualiza silenciosamente os dados do modelo (n_ctx etc.) direto do endpoint,
// sem mexer no dropdown — chamado a cada nova requisição para manter o contexto fresco.
async function refreshModelContext() {
  const { apiUrl, apiKey, model } = state.settings;
  if (!model) return;
  try {
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(`${apiUrl}/models`, { headers });
    if (!res.ok) return;
    const json = await res.json();
    const models = json.data || [];
    const m = models.find(x => x.id === model) || models[0];
    if (m) updateModelInfo(m);
  } catch (e) { /* silencioso: não atrapalha o envio */ }
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
  document.getElementById('check-safety-interactions').checked = s.safetyInteractions;
  document.getElementById('check-websearch').checked = s.webSearch;
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
  state.settings.safetyInteractions = document.getElementById('check-safety-interactions').checked;
  state.settings.webSearch = document.getElementById('check-websearch').checked;
}

// --------------------------------------------------------------------------
//  Ligação de eventos da interface
// --------------------------------------------------------------------------
function wireEvents() {
  // Detecta se o usuário está perto do fim: se rolar para cima, paramos de acompanhar
  const chatBox = document.getElementById('chat-box');
  chatBox.addEventListener('scroll', () => {
    stickToBottom = (chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight) < 80;
  });

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

  // Toggle Auto/Manual de execução de comandos
  document.getElementById('exec-mode').addEventListener('click', (e) => {
    const opt = e.target.closest('.exec-opt');
    if (!opt) return;
    state.settings.execMode = opt.dataset.mode;
    updateExecModeUI();
    persist();
  });

  // Modal de confirmação de execução
  document.getElementById('confirm-approve').addEventListener('click', () => resolveConfirm('approve'));
  document.getElementById('confirm-always').addEventListener('click', () => resolveConfirm('always'));
  document.getElementById('confirm-reject').addEventListener('click', () => resolveConfirm('reject'));
  document.getElementById('confirm-modal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); resolveConfirm('approve'); }
    if (e.key === 'Escape') { e.preventDefault(); resolveConfirm('reject'); }
  });

  // Painel de processos
  document.getElementById('btn-processes').addEventListener('click', openProcessesModal);
  document.getElementById('btn-close-processes').addEventListener('click', closeProcessesModal);
  document.getElementById('btn-clear-finished').addEventListener('click', clearFinishedProcesses);

  // Renomear o chat ativo pelo título do cabeçalho (duplo clique)
  document.getElementById('active-chat-title').addEventListener('dblclick', renameActiveChat);

  // Botão do GitHub (abre a URL do package.json no navegador externo via window.open,
  // que passa pelo setWindowOpenHandler do main.js)
  document.getElementById('btn-github').addEventListener('click', () => {
    if (appInfo.githubUrl) window.open(appInfo.githubUrl, '_blank');
  });

  // Atualiza o contador de processos periodicamente (badge no cabeçalho)
  setInterval(refreshProcesses, 3000);
}

// Informações do app (URL do GitHub etc.) lidas do package.json via IPC
let appInfo = { githubUrl: '', version: '', name: '' };
async function loadAppInfo() {
  try { appInfo = await window.electronAPI.getAppInfo(); } catch (e) { /* ignora */ }
  const gh = document.getElementById('btn-github');
  if (gh) gh.style.display = appInfo.githubUrl ? '' : 'none'; // esconde se não houver URL configurada
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
  updateExecModeUI();   // reflete o modo salvo (auto/manual)
  refreshProcesses();   // popula o badge de processos
  loadAppInfo();        // carrega URL do GitHub etc. do package.json
  // Tenta descobrir os modelos do endpoint padrão já na abertura
  fetchModels();
}

init();
