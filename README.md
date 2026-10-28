# Voxa

Servidores, chat em tempo real, voz e amigos — um app no estilo Discord.

## Estrutura

- `server/` — API (Express) + tempo real (Socket.IO) + banco SQLite (`node:sqlite`, embutido no Node).
- `web/` — interface (React + Vite).
- `desktop/` — app para Windows (Electron), uma janela em volta do site com recursos de desktop.
- `shared/` — regras de permissão de cargos, usadas pelo servidor e pelo site.

## App desktop (Windows)

O app desktop abre o site do Voxa numa janela própria e acrescenta:

- **Seletor de tela** (telas e janelas, com áudio do computador no Windows)
- **Ícone na bandeja**: fechar a janela mantém o Voxa aberto para receber mensagens e chamadas
- **Iniciar com o Windows** (minimizado na bandeja)
- **Contador de não lidas** sobre o ícone na barra de tarefas, e a janela pisca quando chega DM
- **Notificações** de mensagens diretas (exceto em "Não perturbe")
- **Detecção de jogos**: mostra "Jogando X" automaticamente; jogos extras podem ser adicionados em `%APPDATA%\Voxa\custom-games.json` (`{ "jogo.exe": "Nome do jogo" }`). Um status digitado à mão nunca é sobrescrito.
- **Links `voxa://invite/CÓDIGO`** abrem o app direto no convite
- **Atualização automática** a partir das Releases do GitHub

Rodar em desenvolvimento (com o servidor já rodando em `localhost:3001`):

```bash
npm run desktop
```

Para apontar para outro endereço: `VOXA_URL=https://seu-site npm run desktop`.

### Gerar o instalador

O instalador (`Voxa-Setup-x.y.z.exe`) é gerado pelo GitHub Actions (workflow **Desktop**), num Windows de verdade:

1. O app abre o endereço em `voxaAppUrl` no `desktop/package.json` (produção: `https://voxa-fr8h.onrender.com`).
2. Para um instalador de teste: *Actions → Desktop → Run workflow*; o `.exe` fica nos *Artifacts* da execução.
3. Para lançar uma versão: *Actions → Desktop → Run workflow* com **Publicar** marcado (para as próximas, aumente antes `version` em `desktop/package.json`). O instalador fica no link direto **<https://voxa-fr8h.onrender.com/download>** (sempre a versão mais nova), e os apps instalados se atualizam sozinhos.

O instalador não é assinado digitalmente, então o Windows SmartScreen vai mostrar um aviso na primeira instalação ("Mais informações → Executar assim mesmo"). Para tirar o aviso é preciso um certificado de assinatura de código.

## Rodando em desenvolvimento

Requer Node.js 22.13+ (recomendado 24).

```bash
npm install
npm run dev
```

Abra http://localhost:5173. O servidor roda em http://localhost:3001 e o Vite repassa `/api` e `/socket.io` para ele.

## Colocar no ar

Passo a passo para publicar no Render (endereço gratuito com HTTPS, sem precisar de domínio): veja **[DEPLOY.md](DEPLOY.md)**.

## Produção (qualquer servidor)

```bash
npm run build   # gera web/dist
npm start       # serve API + site em http://localhost:3001
```

Variáveis de ambiente:

| Variável | Para quê |
| --- | --- |
| `PORT` | Porta HTTP (padrão 3001) |
| `DB_FILE` | Arquivo do banco (padrão `server/data/voxa.db`) |
| `MEDIA_DIR` | Pasta das imagens enviadas — banners e ícones (padrão: pasta `media` ao lado do banco) |
| `STUN_URLS` | Servidores STUN, separados por vírgula (padrão: STUN público do Google) |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | TURN da Cloudflare (credenciais temporárias geradas pelo servidor) — faz a voz funcionar em qualquer rede |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Alternativa: um servidor TURN próprio (ex.: coturn) |
| `TRUST_PROXY` | Quantos proxies ficam na frente do app (para obter o IP real do usuário) |
| `DOWNLOAD_URL` | Para onde `/download` redireciona (padrão: o instalador mais recente nas Releases do GitHub) |

## Voz

A voz usa WebRTC em malha (cada participante conecta direto aos outros), com cancelamento de eco, supressão de ruído e controle de ganho do navegador. O servidor só repassa a sinalização. Funciona bem até ~8 pessoas por canal; acima disso será preciso um SFU (ex.: LiveKit).

O navegador só libera microfone e tela em `https://` ou em `http://localhost`.

## Banco de dados

O esquema evolui por migrações numeradas em `server/src/db.ts` (registradas em `PRAGMA user_version`). Ao atualizar o Voxa, o banco existente é migrado automaticamente na inicialização, sem perder dados. Faça backup do arquivo `.db` antes de atualizar em produção.

## Testes

```bash
npm test
npm run typecheck
```

## Roteiro

1. ✅ Contas, servidores, convites, canais de texto, chat em tempo real, "digitando…", online/offline
2. ✅ Canais de voz, mutar/ensurdecer, indicador de fala, compartilhamento de tela com áudio
3. ✅ Amigos (pedidos, aceitar, recusar), mensagens diretas com não lidas, status (disponível, ausente, não perturbe, invisível) e "Jogando X"
4. ✅ App desktop para Windows (seletor de tela, bandeja, iniciar com o Windows, contador, notificações, detecção de jogos, atualização automática)
5. ✅ Pronto para produção: Render (`render.yaml`), TURN da Cloudflare, proteção contra tentativas de senha, backup
6. ✅ Nomes e cargos como no Discord: perfil (nome de exibição, senha), apelido por servidor, cargos com cor, permissões e hierarquia, cargo destacado na lista de membros, expulsar e sair, renomear/excluir servidor e canais
7. ✅ Banner do servidor (recorte 16:9 no navegador, aparece no topo dos canais e no convite)
8. ✅ Ícone do servidor (recorte redondo, aparece na barra de servidores e no convite)
