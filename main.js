import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { dirname, join } from 'path';
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 600,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools()
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
  writeFileSync(filePath, content, 'utf-8');
  return { success: true };
});

ipcMain.handle('delete-file', async (event, filePath) => {
  unlinkSync(filePath);
  return { success: true };
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
        cwd, shell: '/bin/bash', detached: true,
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
    process.kill(-pid, 'SIGTERM'); // mata o grupo inteiro (pid negativo = process group)
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch (e) {} }, 3000);
    if (entry) entry.status = 'stopped';
    return { success: true, pid };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Ao fechar o app, encerra tudo que ficou rodando em segundo plano
app.on('before-quit', () => {
  for (const [pid] of procs) {
    try { process.kill(-pid, 'SIGTERM'); } catch (e) { /* ignora */ }
  }
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

ipcMain.handle('set-title', async (event, tile) => {
  const webContents = event.sender;
  const win = BrowserWindow.fromWebContents(webContents);
  win.setTitle(`${app.getVersion()}v${app.getName()} - ${title}`);
});