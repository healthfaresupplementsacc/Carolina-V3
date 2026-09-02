# Slack push em tempo real (Socket Mode) — setup de 5 minutos

Hoje o Claude detecta mensagem em ~10-30s (raspagem). Com isto, o Slack EMPURRA cada
mensagem em **menos de 1 segundo** (o "webhook" que você lembrou do GitHub).

**IMPORTANTE: é um app NOVO, separado.** Não mexa no app "HealthFare Tracker" —
ativar Socket Mode nele desligaria a entrega HTTP pro Railway e quebraria o bot de
produção.

## Passo a passo

1. Abra https://api.slack.com/apps → **Create New App** → **From a manifest**
2. Escolha o workspace **USGS Team** → cole o manifest abaixo → **Create**
3. No menu lateral: **Basic Information** → role até **App-Level Tokens** →
   **Generate Token and Scopes** → nome `socket`, escopo `connections:write` →
   **Generate** → copie o token `xapp-...`
4. Menu lateral: **Install App** → **Install to Workspace** → **Allow** →
   copie o **Bot User OAuth Token** `xoxb-...`
5. No Slack, entre no **#supplements-dashboard** e digite: `/invite @Claude Listener`
   (faça o mesmo no **#admin-orin**)
6. Crie o arquivo
   `scripts\analyst\_watch\tokens.json`
   com o conteúdo:
   ```json
   { "app_token": "xapp-COLE-AQUI", "bot_token": "xoxb-COLE-AQUI" }
   ```
   (ou só me mande os dois tokens que eu crio o arquivo)

Pronto. O listener que já está rodando detecta o arquivo em até 5 min (ou me avisa
que eu reinicio na hora) e conecta. Daí em diante: mensagem postada → chega pro
Claude em <1s.

## Manifest (cole inteiro no passo 2)

```yaml
display_information:
  name: Claude Listener
  description: Escuta mensagens para o Claude (Socket Mode, so leitura)
  background_color: "#1a1a2e"
features:
  bot_user:
    display_name: Claude Listener
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - groups:history
      - im:history
      - channels:read
      - users:read
      - app_mentions:read
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - app_mention
  socket_mode_enabled: true
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  token_rotation_enabled: false
```

## O que já está rodando sem você fazer nada

- Watchdog 24/7 (raspagem a cada 10s + mantém o Chrome do Claude vivo) — já pega
  suas mensagens hoje, só que com 10-30s de atraso.
- Quando o Socket Mode conectar, o watchdog percebe sozinho e para de raspar
  (vira só keep-alive do Chrome). Se o socket cair, ele volta a raspar sozinho.
  Dois caminhos, zero buraco.
