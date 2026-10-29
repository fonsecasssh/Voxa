# Colocando o Voxa no ar (Render)

Custo: plano **Starter** (US$ 7/mês) + **disco de 1 GB** (US$ 0,25/mês). O endereço é gratuito,
no formato `https://voxa.onrender.com` (ou `voxa-xxxx.onrender.com` se o nome estiver ocupado),
já com HTTPS. Não é preciso ter domínio.

## 1. Criar o serviço no Render

1. Crie uma conta em <https://render.com> (pode entrar com o GitHub) e cadastre um cartão em *Billing*.
2. No painel, clique em **New → Blueprint**.
3. Conecte o GitHub e escolha o repositório **fonsecasssh/Voxa**.
4. O Render lê o arquivo `render.yaml` e mostra o serviço **voxa** com o disco **voxa-data**.
   Ele vai pedir os valores de `CLOUDFLARE_TURN_KEY_ID` e `CLOUDFLARE_TURN_API_TOKEN`:
   pode deixar em branco por enquanto (passo 3) e clicar em **Apply**.
5. Espere o primeiro deploy terminar (uns 3 minutos). O endereço aparece no topo da página do serviço.

A partir daí, **cada push na branch `main` atualiza o site sozinho**.

## 2. Conferir

Abra `https://SEU-ENDERECO.onrender.com` — deve aparecer a tela de login do Voxa. Crie sua conta.

### Conferir o IP (proteção contra spam de cadastro)

Abra `https://SEU-ENDERECO.onrender.com/api/health`. Ele mostra `"ip": "..."`.
Compare com o seu IP real (por exemplo em <https://meuip.com.br>):

- **Iguais:** está tudo certo.
- **Diferentes:** em *Environment*, mude `TRUST_PROXY` (tente 2, depois 4, 1…) até ficarem iguais.
  Se nenhum valor bater, apague a variável: o limite de cadastros por rede fica desligado,
  mas o bloqueio de senhas erradas por conta continua funcionando.

## 3. Voz em qualquer rede (TURN da Cloudflare, grátis até 1 TB/mês)

Sem isso a voz funciona na maioria das redes domésticas, mas pode ficar muda para quem está
em 4G/5G ou em redes de empresa/faculdade.

1. Crie uma conta gratuita na Cloudflare: <https://dash.cloudflare.com/sign-up>.
2. No menu, vá em **Realtime → TURN Server** (em alguns painéis aparece como *Calls → TURN*) e clique em **Create**.
   Dê um nome (ex.: `voxa`).
3. A Cloudflare mostra o **Turn Token ID** e o **API Token**. Copie os dois (o API Token só aparece uma vez).
4. No Render, no serviço **voxa → Environment**, preencha:
   - `CLOUDFLARE_TURN_KEY_ID` = Turn Token ID
   - `CLOUDFLARE_TURN_API_TOKEN` = API Token
5. Salve. O Render reinicia o serviço; nos *Logs* deve aparecer `voz: Cloudflare TURN`.

## 4. App desktop apontando para o site

O endereço de produção fica em `desktop/package.json`, no campo `voxaAppUrl`
(hoje `https://voxa-fr8h.onrender.com`). Se o endereço mudar (por exemplo, ao comprar um domínio),
troque esse campo — ou crie a variável `VOXA_APP_URL` em
*Settings → Secrets and variables → Actions → Variables*, que tem prioridade.

Para lançar uma versão (o link de download para os amigos):

1. No GitHub, abra **Actions → Desktop → Run workflow**.
2. Marque **Publicar como nova versão** e clique em **Run workflow**.
3. Em ~2 minutos o instalador fica disponível. Links de download direto (sempre a versão mais nova):
   - **<https://voxa-fr8h.onrender.com/download>** — o mais fácil de mandar
   - <https://github.com/fonsecasssh/Voxa/releases/latest/download/Voxa-Setup.exe>

   O site também tem o botão "Baixar o Voxa para Windows".

Para as próximas versões, antes aumente `version` em `desktop/package.json` (ex.: 0.1.1) e faça commit.
Quem já tem o app instalado recebe a atualização sozinho. (Também dá para publicar criando a tag
`v0.1.1` e enviando com `git push origin v0.1.1`.)

## Backup

O Voxa tira sozinho uma cópia do banco por dia (com o servidor rodando, sem pausa) e guarda as
últimas 7 em `/var/data/backups` (`voxa-AAAA-MM-DD-HHMM.db`). Dá para mudar com `BACKUP_KEEP`
(quantas guardar), `BACKUP_DIR` (onde) ou desligar com `BACKUP_DISABLED=1`.

Essas cópias ficam no mesmo disco: protegem contra erro e banco corrompido, não contra perder o disco.
Por isso o snapshot diário do Render (*Disks → Snapshots*, guardado por 7 dias) continua valendo, e
de vez em quando vale baixar uma cópia de `/var/data/backups` pelo *Shell* do Render.
Para uma cópia extra na hora: *Shell* do Render, `npm run backup -w server`.
As imagens e arquivos enviados ficam em `/var/data/media`, no mesmo disco, e entram no snapshot.

## Recursos opcionais (variáveis de ambiente)

Tudo isto fica desligado até você preencher as variáveis em *Environment* no Render.

### Busca de GIFs

- `GIPHY_API_KEY`: chave grátis em <https://developers.giphy.com> (*Create an App → API*).

### Recuperar senha por e-mail

Com isto, quem confirmar um e-mail no perfil pode usar "Esqueci minha senha" no login.
Exemplo com Gmail (crie uma *senha de app* em <https://myaccount.google.com/apppasswords>; precisa da verificação em duas etapas ligada):

- `SMTP_HOST` = `smtp.gmail.com`
- `SMTP_PORT` = `465`
- `SMTP_USER` = seu endereço do Gmail
- `SMTP_PASS` = a senha de app (16 letras, sem espaços)
- `SMTP_FROM` (opcional) = `Voxa <seu@gmail.com>`

Os links dos e-mails usam o endereço do site: no Render ele é detectado sozinho (`RENDER_EXTERNAL_URL`);
com domínio próprio, defina `PUBLIC_URL` (ex.: `https://voxa.seudominio.com`).

### Servidor de mídia (LiveKit) para chamadas maiores

Sem isto, cada pessoa da chamada envia áudio e vídeo direto para cada outra (ótimo até ~8 pessoas).
Com um servidor LiveKit, cada um envia uma vez só e o servidor repassa — bom para chamadas grandes,
câmeras e transmissões com muita gente assistindo.

1. Crie um projeto grátis em <https://cloud.livekit.io> (ou hospede o LiveKit você mesmo).
2. Em *Settings → Keys*, crie uma chave e preencha:
   - `LIVEKIT_URL` = a URL do projeto (`wss://...livekit.cloud`)
   - `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`
3. Pronto: as próximas chamadas (canais de voz e DMs) passam pelo LiveKit. Apague as variáveis para voltar ao modo direto.

O Voxa continua decidindo quem entra em cada canal: ele entrega a cada pessoa um acesso válido só para aquela sala.

## Observações

- A cada deploy o serviço fica fora do ar por alguns segundos (serviços com disco não têm troca sem pausa).
  Quem estiver conectado reconecta sozinho; quem estiver em chamada de voz precisa entrar de novo.
- Sem LiveKit, a voz é direta entre as pessoas: ótima até ~8 pessoas por canal (veja "Servidor de mídia" acima).
