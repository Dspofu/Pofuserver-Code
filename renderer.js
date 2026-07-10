let currentWorkspace = '';

document.getElementById('btn-select-folder').addEventListener('click', async () => {
  const folderPath = await window.electronAPI.selectFolder();
  if (folderPath) {
    currentWorkspace = folderPath;
    document.getElementById('selected-path').innerText = folderPath;
    document.getElementById('user-input').disabled = false;
    document.getElementById('btn-send').disabled = false;
    logSystem(`Workspace definido para: ${folderPath}`);
  }
});

document.getElementById('btn-send').addEventListener('click', () => {
  const inputEl = document.getElementById('user-input');
  const prompt = inputEl.value.trim();
  if (!prompt) return;

  appendMessage(prompt, 'user');
  inputEl.value = '';
  runAgentLoop(prompt);
});

function appendMessage(text, sender) {
  const chatBox = document.getElementById('chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${sender}`;
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

// Definição das Ferramentas que a IA pode chamar
const tools = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Lista todos os arquivos e pastas no diretório de trabalho atual.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Lê o conteúdo de um arquivo específico no workspace.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Nome ou caminho relativo do arquivo" }
        },
        required: ["filename"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Cria ou sobrescreve um arquivo com um conteúdo específico.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Nome do arquivo a ser salvo" },
          content: { type: "string", description: "Conteúdo completo a ser escrito no arquivo" }
        },
        required: ["filename", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Executa um comando no terminal dentro do diretório do workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Comando shell para rodar (ex: npm install, node app.js)" }
        },
        required: ["command"]
      }
    }
  }
];

async function runAgentLoop(userPrompt) {
  const apiUrl = document.getElementById('api-url').value.trim();
  const modelName = document.getElementById('model-name').value.trim();

  // Histórico de mensagens do agente
  let messages = [
    { 
      role: "system", 
      content: `Você é um assistente de desenvolvimento que tem acesso direto aos arquivos do projeto local. O diretório de trabalho atual é: ${currentWorkspace}. Use as ferramentas fornecidas para interagir com o ambiente conforme solicitado pelo usuário.` 
    },
    { role: "user", content: userPrompt }
  ];

  let keepGoing = true;

  while (keepGoing) {
    try {
      logSystem("Pensando...");
      const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: messages,
          tools: tools,
          tool_choice: "auto"
        })
      });

      const data = await response.json();
      const choice = data.choices[0];
      const message = choice.message;

      // Adiciona a resposta do modelo ao histórico para manter o contexto
      messages.push(message);

      if (message.content) {
        appendMessage(message.content, 'agent');
      }

      // Verifica se a IA solicitou o uso de ferramentas
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const name = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          let result = '';

          logSystem(`IA chamou ação: ${name} com argumentos: ${JSON.stringify(args)}`);

          if (name === 'list_files') {
            const files = await window.electronAPI.listFiles(currentWorkspace);
            result = JSON.stringify(files);
          } else if (name === 'read_file') {
            const filePath = `${currentWorkspace}/${args.filename}`;
            result = await window.electronAPI.readFile(filePath);
          } else if (name === 'write_file') {
            const filePath = `${currentWorkspace}/${args.filename}`;
            const res = await window.electronAPI.writeFile(filePath, args.content);
            result = JSON.stringify(res);
          } else if (name === 'execute_command') {
            const res = await window.electronAPI.executeCommand(args.command, currentWorkspace);
            result = JSON.stringify(res);
          }

          // Envia o resultado da execução de volta para a IA
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: name,
            content: result
          });
        }
      } else {
        // Se a IA não chamou nenhuma ferramenta, ela terminou de responder o usuário
        keepGoing = false;
      }

    } catch (err) {
      logSystem(`Erro no loop da IA: ${err.message}`);
      keepGoing = false;
    }
  }
}