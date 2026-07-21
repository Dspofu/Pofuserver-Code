import { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } from 'electron';
import { dirname, join } from 'path';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// No Windows não existe /bin/bash nem grupos de processos no sentido POSIX; várias
// rotinas de terminal precisam de tratamento específico por plataforma.
const isWindows = process.platform === 'win32';

let mainWindow;

// Precisa ser idêntico ao "build.appId" do package.json: o instalador NSIS grava esse
// mesmo AUMID no atalho, e o Windows só associa a janela ao atalho (ícone correto na
// barra de tarefas + fixar) quando os dois valores batem.
app.setAppUserModelId("com.dspofu.pofusercoderstudio")

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 600,
    icon: join(__dirname, 'assets', 'icon.png'), // usado no Linux/Windows em desenvolvimento (empacotado usa o ícone do build)
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools()

  // Links (ex: markdown gerado pela IA, target="_blank" ou window.open) nunca abrem
  // dentro do app — sempre no navegador padrão do sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Bloqueia qualquer navegação para fora do próprio index.html (cliques em <a> sem
  // target, redirecionamentos etc.) e abre a URL no navegador externo em vez disso.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://') && url.includes('index.html')) return; // navegação interna legítima
    event.preventDefault();
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url);
  });

  // Menu de contexto nativo no clique direito (copiar/colar/selecionar), essencial
  // para copiar textos das respostas. Também oferece abrir link no navegador externo.
  mainWindow.webContents.on('context-menu', (event, params) => {
    const items = [];
    const { editFlags, selectionText, isEditable, linkURL } = params;
    if (linkURL) {
      items.push({ label: 'Abrir link no navegador', click: () => shell.openExternal(linkURL) });
      items.push({ label: 'Copiar endereço do link', click: () => clipboard.writeText(linkURL) });
      items.push({ type: 'separator' });
    }
    if (isEditable) {
      items.push({ label: 'Desfazer', role: 'undo', enabled: editFlags.canUndo });
      items.push({ label: 'Refazer', role: 'redo', enabled: editFlags.canRedo });
      items.push({ type: 'separator' });
      items.push({ label: 'Recortar', role: 'cut', enabled: editFlags.canCut });
    }
    items.push({ label: 'Copiar', role: 'copy', enabled: editFlags.canCopy || !!selectionText });
    if (isEditable) items.push({ label: 'Colar', role: 'paste', enabled: editFlags.canPaste });
    items.push({ type: 'separator' });
    items.push({ label: 'Selecionar tudo', role: 'selectAll' });
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Manipuladores IPC para ações do sistema de arquivos e terminal
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.filePaths[0];
});

ipcMain.handle('list-files', async (event, dirPath) => {
  return readdirSync(dirPath, { withFileTypes: true }).map(item => ({
    name: item.name,
    isDirectory: item.isDirectory()
  }));
});

ipcMain.handle('read-file', async (event, filePath) => {
  return readFileSync(filePath, 'utf-8');
});

ipcMain.handle('write-file', async (event, filePath, content) => {
  mkdirSync(dirname(filePath), { recursive: true }); // cria as pastas pai se não existirem
  writeFileSync(filePath, content, 'utf-8');
  return { success: true };
});

ipcMain.handle('create-directory', async (event, dirPath) => {
  mkdirSync(dirPath, { recursive: true });
  return { success: true };
});

// Informações do app lidas do package.json (ex: URL do GitHub, versão)
ipcMain.handle('get-app-info', async () => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    return {
      githubUrl: pkg.githubUrl || pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '',
      version: pkg.version || '',
      name: pkg.productName || pkg.name || ''
    };
  } catch (e) {
    return { githubUrl: '', version: '', name: '' };
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  unlinkSync(filePath);
  return { success: true };
});

// Lista recursiva dos ARQUIVOS do workspace, usada pelo autocomplete de menção (@arquivo).
// Ignora pastas pesadas/geradas e limita a quantidade para não travar projetos gigantes.
const MENTION_IGNORE = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.cache',
  'vendor', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj', '.git'
]);
const MENTION_FILE_CAP = 5000;

ipcMain.handle('list-tree', async (event, rootPath) => {
  const files = [];
  const walk = (dir, rel) => {
    if (files.length >= MENTION_FILE_CAP) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (files.length >= MENTION_FILE_CAP) return;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        // pula pastas ignoradas e ocultas (.git, .idea, etc.), mas mantém arquivos ocultos
        if (ent.name.startsWith('.') || MENTION_IGNORE.has(ent.name)) continue;
        walk(join(dir, ent.name), relPath);
      } else if (ent.isFile()) {
        files.push(relPath);
      }
    }
  };
  try { walk(rootPath, ''); } catch (e) { /* ignora */ }
  return { files, capped: files.length >= MENTION_FILE_CAP };
});

// ==========================================================================
//  Execução de comandos com gerenciamento inteligente de processos
// ==========================================================================
// Registro de processos vivos (servidores, watchers, etc.). Cada entrada mantém
// um buffer rolante de logs para que o agente possa inspecioná-los depois.
const procs = new Map(); // pid -> { command, child, stdout, stderr, startedAt, ready, status }

const LOG_CAP = 200 * 1024; // buffer rolante por stream
// Padrões que indicam que um servidor "subiu" (retorno antecipado, sem esperar o timeout)
const READY_PATTERNS = [
  /listening on/i, /now listening/i, /server (is )?(running|started|up|listening)/i,
  /running on/i, /started server/i, /uvicorn running/i, /serving (http|at|on)/i,
  /\blocal:\s*https?:\/\//i, /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)[:\/]/i,
  /compiled successfully/i, /ready in \d/i, /ready on/i, /accepting connections/i,
  /listening at/i, /development server/i, /app running/i, /nest application successfully started/i
];

function appendCapped(entry, key, chunk) {
  entry[key] += chunk;
  if (entry[key].length > LOG_CAP) entry[key] = entry[key].slice(-LOG_CAP);
}

// Shell por plataforma. No Windows usamos o cmd.exe (ComSpec); no restante, /bin/bash.
// Antes isto era fixo em '/bin/bash', o que fazia o spawn falhar no Windows com
// "spawn /bin/bash ENOENT" — o executável simplesmente não existe lá.
const SHELL = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/bash';

// Encerra um processo E TODA a sua árvore de filhos, de forma multiplataforma.
//  - POSIX: mata o grupo de processos inteiro (pid negativo), possível porque o
//    processo foi criado com `detached: true` (vira líder do próprio grupo).
//  - Windows: `process.kill(-pid)` lança erro (não há grupos POSIX); usamos
//    `taskkill /T` que derruba o processo e todos os descendentes.
function killTree(pid, { force = false } = {}) {
  if (!pid) return;
  if (isWindows) {
    const args = ['/pid', String(pid), '/T'];
    if (force) args.push('/F');
    try { spawn('taskkill', args, { windowsHide: true }); } catch (e) { /* ignora */ }
  } else {
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { /* ignora */ }
  }
}

ipcMain.handle('execute-command', async (event, command, cwd, opts = {}) => {
  const hardTimeoutMs = opts.timeoutMs || 25000; // teto absoluto para tarefas que terminam
  const idleMs = opts.idleMs || 2500;            // silêncio => provável servidor ocioso esperando conexões
  const graceMs = 600;                           // tempo mínimo antes de considerar "ocioso"

  return new Promise((resolve) => {
    // detached + stdin ignorado => sessão própria, SEM terminal de controle:
    //  - impede que `sudo` sequestre o terminal do usuário (falha com "a terminal is required")
    //  - permite deixar servidores rodando em segundo plano sem travar o app
    let child;
    try {
      child = spawn(command, {
        cwd, shell: SHELL, detached: true,
        windowsHide: true, // no Windows, evita piscar uma janela de console a cada comando
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0' }
      });
    } catch (err) {
      return resolve({ command, stdout: '', stderr: '', error: err.message, finished: true });
    }

    const entry = { command, child, stdout: '', stderr: '', startedAt: Date.now(), ready: false, status: 'running' };
    let settled = false;
    let idleTimer = null;

    const backgroundify = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      entry.ready = true;
      procs.set(child.pid, entry);
      child.unref();
      resolve({
        command, pid: child.pid, finished: false, backgrounded: true, reason,
        stdout: entry.stdout, stderr: entry.stderr,
        note: `Processo iniciado em segundo plano (PID ${child.pid}) — ${reason}. ` +
              `O chat NÃO travou. Use read_process_output(${child.pid}) para ver os logs, ` +
              `list_processes para listar, e stop_process(${child.pid}) para encerrar.`
      });
    };

    // Reinicia o "cronômetro de ocioso" a cada saída: builds barulhentos seguem esperando;
    // servidores que imprimem o banner e ficam quietos são considerados prontos.
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (Date.now() - entry.startedAt >= graceMs) backgroundify('ficou ocioso (provável servidor aguardando conexões)');
      }, idleMs);
    };

    const onData = (key) => (d) => {
      const s = d.toString();
      appendCapped(entry, key, s);
      // Detecção de "pronto" por padrão de log
      if (!settled && READY_PATTERNS.some(re => re.test(s))) {
        backgroundify('detectado como servidor pronto (padrão de log)');
        return;
      }
      bumpIdle();
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    bumpIdle();

    const hardTimer = setTimeout(() => backgroundify(`ainda em execução após ${Math.round(hardTimeoutMs / 1000)}s`), hardTimeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer); clearTimeout(idleTimer);
      resolve({ command, stdout: entry.stdout, stderr: entry.stderr, error: err.message, finished: true });
    });

    child.on('close', (code) => {
      entry.status = 'exited';
      if (settled) return; // já estava em segundo plano — apenas marca como encerrado no registro
      settled = true;
      clearTimeout(hardTimer); clearTimeout(idleTimer);
      resolve({
        command, stdout: entry.stdout, stderr: entry.stderr,
        error: code === 0 ? null : `Processo encerrou com código ${code}`,
        exitCode: code, finished: true
      });
    });
  });
});

// Lê o output acumulado de um processo em segundo plano
ipcMain.handle('read-process-output', async (event, pid) => {
  const entry = procs.get(pid);
  if (!entry) return { success: false, error: `Nenhum processo em segundo plano com PID ${pid}` };
  return {
    success: true, pid, command: entry.command, status: entry.status,
    uptimeSec: Math.round((Date.now() - entry.startedAt) / 1000),
    stdout: entry.stdout, stderr: entry.stderr
  };
});

// Lista processos em segundo plano conhecidos
ipcMain.handle('list-processes', async () => {
  return Array.from(procs.values()).map(e => ({
    pid: e.child.pid, command: e.command, status: e.status,
    uptimeSec: Math.round((Date.now() - e.startedAt) / 1000)
  }));
});

// Encerra um processo em segundo plano (e todo o seu grupo, por ser detached)
ipcMain.handle('stop-process', async (event, pid) => {
  const entry = procs.get(pid);
  try {
    killTree(pid);                                       // pedido educado (SIGTERM / taskkill sem /F)
    setTimeout(() => killTree(pid, { force: true }), 3000); // força se ainda estiver vivo
    if (entry) entry.status = 'stopped';
    return { success: true, pid };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Remove do registro os processos já encerrados (limpa o painel)
ipcMain.handle('clear-finished-processes', async () => {
  for (const [pid, e] of procs) {
    if (e.status !== 'running') procs.delete(pid);
  }
  return { success: true };
});

// Ao fechar o app, encerra tudo que ficou rodando em segundo plano
app.on('before-quit', () => {
  for (const [pid] of procs) killTree(pid, { force: true });
});

// Persistência local (chats e configurações) no diretório de dados do usuário
const storePath = () => join(app.getPath('userData'), 'app-store.json');

ipcMain.handle('load-store', async () => {
  try {
    const file = storePath();
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    return null;
  }
});

ipcMain.handle('save-store', async (event, data) => {
  try {
    writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Atualiza o título da janela (ex.: "Pofuserver Coder Studio — pensando…")
ipcMain.on('set-title', (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && typeof title === 'string' && title.trim()) win.setTitle(title);
});

// ==========================================================================
//  Busca na web (DuckDuckGo, sem chave de API) + leitura de páginas
// ==========================================================================
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
// Cabeçalhos "de navegador" reduzem os bloqueios anti-bot do DuckDuckGo
const WEB_HEADERS = {
  'User-Agent': WEB_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://duckduckgo.com/',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin'
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function stripTags(s) { return String(s).replace(/<[^>]*>/g, ''); }

// Extrai a URL real do redirecionador do DuckDuckGo (//duckduckgo.com/l/?uddg=...)
function ddgRealUrl(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
  if (href.startsWith('//')) return 'https:' + href;
  return href;
}

function parseDdgResults(html, max) {
  const results = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  let m;
  while ((m = snipRe.exec(html)) !== null) snippets.push(decodeEntities(stripTags(m[1])).trim());
  let i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < max) {
    results.push({
      title: decodeEntities(stripTags(m[2])).trim(),
      url: ddgRealUrl(m[1]),
      snippet: snippets[i] || ''
    });
    i++;
  }
  return results;
}

// Busca no HTML do DuckDuckGo com retry/backoff (o DDG responde 202 quando limita por taxa)
async function ddgHtmlSearch(query, max) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=br-pt';
  const backoffs = [0, 1500, 3200]; // tenta 3x, esperando mais a cada bloqueio
  for (const wait of backoffs) {
    if (wait) await sleep(wait);
    let resp;
    try { resp = await fetch(url, { headers: WEB_HEADERS }); } catch (e) { continue; }
    const html = await resp.text();
    const blocked = resp.status === 202 || /anomaly|challenge|unusual traffic|If this error persists/i.test(html);
    if (!blocked) {
      const results = parseDdgResults(html, max);
      if (results.length) return results;
    }
  }
  return null; // bloqueado ou sem resultados após as tentativas
}

// Fallback: API oficial de Instant Answer do DuckDuckGo (JSON, não bloqueia — mas só dá resumos)
async function ddgInstantAnswer(query, max) {
  try {
    const resp = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) +
      '&format=json&no_html=1&no_redirect=1&t=pofuserver', { headers: { 'User-Agent': WEB_UA } });
    const j = await resp.json();
    const results = [];
    if (j.AbstractText) results.push({ title: j.Heading || query, url: j.AbstractURL || '', snippet: j.AbstractText });
    if (j.Answer) results.push({ title: 'Resposta direta', url: j.AbstractURL || '', snippet: String(j.Answer) });
    for (const t of (j.RelatedTopics || [])) {
      const items = t.Topics ? t.Topics : [t];
      for (const it of items) {
        if (it.Text && results.length < max) {
          results.push({ title: it.Text.split(/ - | — /)[0].slice(0, 80), url: it.FirstURL || '', snippet: it.Text });
        }
      }
    }
    return results.slice(0, max);
  } catch (e) { return null; }
}

ipcMain.handle('web-search', async (event, query, maxResults = 5) => {
  const max = Math.min(Math.max(maxResults || 5, 1), 10);
  try {
    let results = await ddgHtmlSearch(query, max);
    let source = 'duckduckgo';
    if (!results || !results.length) {
      results = await ddgInstantAnswer(query, max); // recorre ao resumo oficial
      source = 'duckduckgo-instant';
    }
    if (!results || !results.length) {
      return { success: false, error: 'Sem resultados — o DuckDuckGo pode ter limitado as requisições temporariamente. Tente novamente em alguns segundos.' };
    }
    return { success: true, query, source, count: results.length, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Converte HTML em texto legível (remove scripts/estilos/tags, normaliza espaços)
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

ipcMain.handle('fetch-url', async (event, url, maxChars = 8000) => {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': WEB_UA }, redirect: 'follow' });
    const ct = resp.headers.get('content-type') || '';
    let text = await resp.text();
    if (ct.includes('html') || /^\s*</.test(text)) text = htmlToText(text);
    return { success: true, url, status: resp.status, content: text.slice(0, maxChars) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});