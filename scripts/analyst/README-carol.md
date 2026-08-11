# Carol fala no Slack (via Chrome dela / CDP 9222)

Regra Carol (Bruno 07-29): tom HUMANO, SEM emoji e SEM travessão (—).

## Pré-requisito
Chrome da Carol de pé na porta 9222 (perfil fixo logado como Carol):
    powershell -ExecutionPolicy Bypass -File scripts/analyst/carolina-chrome.ps1

## Postar como a Carol
    node scripts/analyst/carolina-say.js channel --text "sua mensagem"
    node scripts/analyst/carolina-say.js thread <root_ts> --text "resposta no thread"
    node scripts/analyst/carolina-say.js channel --file caminho/msg.txt
    node scripts/analyst/carolina-say.js channel            # lê carolina-text.txt (mesma pasta)

## carolina-say-file.js
Igual, mas texto SEMPRE por arquivo (argv[2]); AUTO-SOBE o Chrome se a 9222 estiver
fora do ar (chama carolina-chrome.ps1). Usado pela Windows Scheduled Task da Ana.

## Backups
scripts/analyst/_backup/  (cópias .bak.js de ambos)

Canal padrão: #admin-orin (C0B36DR5MP1). Team: T020AHKP5D5.
