export const system_prompt = (path, web_search) => `Você é um assistente de desenvolvimento sênior com acesso direto aos arquivos do projeto local. O diretório de trabalho atual é: ${path}. Responda em português.

PRINCÍPIOS DE TRABALHO:
1. Investigue antes de agir: use list_files e read_file para entender a estrutura, convenções e o estilo do projeto ANTES de criar ou alterar código. Não presuma nomes de arquivos, dependências ou frameworks — verifique.
2. Passos pequenos e verificados: faça uma mudança de cada vez e confirme o resultado (rode testes/linters/o próprio programa com execute_command) antes de prosseguir. Se um comando falhar, LEIA o stderr/exit code retornado e corrija a causa — não repita o mesmo comando.
3. Código idiomático: siga as convenções já presentes no projeto (indentação, nomes, padrões). Prefira editar arquivos existentes a recriá-los; leia o arquivo antes de sobrescrevê-lo para não perder conteúdo. Arquivos grandes são lidos em PARTES (janelas de linhas): se o read_file avisar que restam linhas, use o parâmetro offset para ler o restante ANTES de reescrever o arquivo inteiro — senão você apaga o que ficou fora da janela.
4. Ferramentas de arquivo: use write_file (cria as pastas pai automaticamente), create_directory, read_file e delete_file em vez de comandos de shell equivalentes quando possível — é mais seguro e claro.
5. Processos longos: servidores/APIs (execute_command que não termina) rodam em segundo plano e retornam um PID. Continue trabalhando; verifique se subiu com read_process_output(pid) e encerre com stop_process(pid) quando não precisar mais. Evite sudo e comandos interativos.
6. Seja explícito sobre suposições e limitações. Quando a tarefa estiver concluída, responda ao usuário com um resumo objetivo do que foi feito, sem chamar mais ferramentas.`
+web_search&&
"7. Informação externa/atual: use web_search para pesquisar e fetch_url para ler o conteúdo de um resultado antes de citá-lo. Não invente URLs nem dados que você não verificou.";

export const DEFAULT_SETTINGS = {
  apiUrl: 'http://localhost:8080/v1',
  model: '',
  apiKey: '',
  temperature: 0.7,
  topP: 0.9,
  // Modelos de raciocínio gastam boa parte do orçamento no bloco de think antes de
  // emitir o tool_call; com folga de menos, a chamada é cortada no meio dos argumentos
  // e chega com JSON quebrado (finish_reason 'length').
  maxTokens: 8192,
  noThink: false, // modelos de raciocínio (ex: Qwen3) precisam pensar para chamar ferramentas
  cmdTimeout: 20, // segundos até um comando ser considerado "rodando em segundo plano"
  webSearch: false, // habilita as ferramentas de busca na web (web_search / fetch_url)
  execMode: 'manual', // 'manual' pede confirmação antes de rodar comandos; 'auto' executa direto
  safetyInteractions: true // Implatação de segurança para evitar que o modelo esteja possivelmente alucinando
};

export const APP_NAME = 'Pofuserver Coder Studio';

export const MAX_TOOL_RESULT_CHARS = 6000; // teto p/ resultados de web (web_search / fetch_url)

// Leitura de arquivos: em vez de CORTAR um arquivo grande em silêncio (o modelo só via o
// começo e "perdia" o resto — e, ao reescrever com write_file, apagava o que ficou de fora),
// read_file devolve o conteúdo em JANELAS de linhas e informa como pedir a próxima parte
// (paginação por offset). Assim um modelo com contexto de sobra (ex: Qwen3 27B) consegue ler
// um arquivo de 1000+ linhas por completo, em partes, sem perda.
export const READ_FILE_MAX_LINES = 500;    // linhas por leitura (padrão e teto)
export const READ_FILE_MAX_CHARS = 20000;  // trava secundária p/ linhas muito longas (ex: minificados)
// Trava de segurança ALTA apenas contra loop verdadeiramente infinito; o controle
// real é o botão "Parar". Tarefas longas e legítimas rodam sem serem bloqueadas.
export const MAX_LOOP_ITERATIONS = 100;

// Tentativas por requisição. Um tool_call malformado faz o llama.cpp responder 500 e é
// transitório (a geração é estocástica) — repetir costuma resolver, e sem isso a run
// inteira do agente morre por causa de uma única resposta ruim.
export const MAX_REQUEST_RETRIES = 3;
export const REQUEST_RETRY_DELAY_MS = 800;