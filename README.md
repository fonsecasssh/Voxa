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

Variáveis de ambiente: `PORT` (padrão 3001) e `DB_FILE` (padrão `server/data/voxa.db`).

## Testes

```bash
npm test
npm run typecheck
```

## Roteiro

1. ✅ Contas, servidores, convites, canais de texto, chat em tempo real, "digitando…", online/offline
2. Voz e compartilhamento de tela (WebRTC)
3. Amigos, mensagens diretas, status de jogo
4. App desktop (Electron)
5. Deploy em produção
