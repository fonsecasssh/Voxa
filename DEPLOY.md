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

Para lançar uma versão com atualização automática:

```bash
# mude "version" em desktop/package.json (ex.: 0.1.1), faça commit, e então:
git tag v0.1.1 && git push origin v0.1.1
```

O GitHub Actions gera o instalador e publica em **Releases** — esse é o link para mandar para os amigos.
Quem já tem o app instalado recebe a atualização sozinho.

## Backup

O Render tira uma cópia (*snapshot*) do disco automaticamente todo dia e guarda por 7 dias
(*Disks → Snapshots*), dá para restaurar por lá. Para uma cópia extra na hora, abra o *Shell* do
serviço no Render e rode `npm run backup -w server` — a cópia é salva em `/var/data/backup-DATA.db`.
As imagens enviadas (banners dos servidores) ficam em `/var/data/media`, no mesmo disco, e entram no snapshot.

## Observações

- A cada deploy o serviço fica fora do ar por alguns segundos (serviços com disco não têm troca sem pausa).
  Quem estiver conectado reconecta sozinho; quem estiver em chamada de voz precisa entrar de novo.
- A voz é direta entre as pessoas (sem servidor de mídia): ótima até ~8 pessoas por canal.
