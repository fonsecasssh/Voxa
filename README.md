# Voxa

Servidores, chat em tempo real, voz e amigos — um app no estilo Discord.

## Estrutura

- `server/` — API (Express) + tempo real (Socket.IO) + banco SQLite (`node:sqlite`, embutido no Node).
- `web/` — interface (React + Vite).

## Rodando em desenvolvimento

Requer Node.js 22.13+ (recomendado 24).

```bash
npm install
npm run dev
```

Abra http://localhost:5173. O servidor roda em http://localhost:3001 e o Vite repassa `/api` e `/socket.io` para ele.

## Produção

```bash
npm run build   # gera web/dist
npm start       # serve API + site em http://localhost:3001
```

Variáveis de ambiente:

| Variável | Para quê |
| --- | --- |
| `PORT` | Porta HTTP (padrão 3001) |
| `DB_FILE` | Arquivo do banco (padrão `server/data/voxa.db`) |
| `STUN_URLS` | Servidores STUN, separados por vírgula (padrão: STUN público do Google) |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Servidor TURN, necessário em produção para quem está atrás de NAT restritivo |

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
4. App desktop (Electron)
5. Deploy em produção
