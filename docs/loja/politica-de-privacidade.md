# política de privacidade do full-print

Última atualização: 2 de novembro de 2026

O full-print é uma extensão para navegadores Chromium que captura páginas inteiras e exporta em PNG ou PDF.

## resumo

**O full-print não coleta, não envia e não compartilha nenhum dado seu.** Tudo acontece no seu computador, dentro do navegador.

## o que a extensão faz com os dados

- **Capturas de tela:** quando você clica no ícone da extensão, a página da aba ativa é capturada. A imagem é guardada apenas no armazenamento local do navegador (IndexedDB), para que a prévia possa exibi-la. Ela é apagada automaticamente após 24 horas, e só as 5 capturas mais recentes são mantidas.
- **Exportação:** copiar, salvar PNG e salvar PDF só acontecem quando você clica nos botões da prévia. Os arquivos são gerados no próprio navegador.
- **Registro técnico (log):** a extensão guarda localmente apenas metadados da captura, como tempos, contagens e o endereço da página sem parâmetros e sem fragmento. Nunca guarda o conteúdo da página. Esse registro fica no seu navegador e não é enviado a lugar nenhum.

## o que a extensão não faz

- Não envia capturas, endereços ou qualquer informação para servidores, nossos ou de terceiros.
- Não tem backend, conta de usuário, anúncios, análise de uso ou telemetria.
- Não executa código remoto.
- Não vende nem transfere dados a terceiros.

## permissões do navegador

- **activeTab:** acessar a aba em que você clicou no ícone, somente para capturá-la.
- **debugger:** usar o protocolo de depuração do Chrome para capturar a página inteira em alta resolução. É anexado só durante a captura e desanexado ao final.
- **storage:** guardar localmente o estado da captura em andamento.

## contato

Dúvidas sobre esta política: barbaragianazi@gmail.com

Código-fonte: https://github.com/barbaragianazi/full-print
