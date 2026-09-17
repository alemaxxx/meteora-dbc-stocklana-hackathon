> **Nota deste recorte (16/09/2026)**: este documento foi escrito no contexto do
> [Lançar Token Bot](https://github.com/alemaxxx/lauch-token) original (bot maior, com detecção de
> onda StonkFun/pump.fun). Este repositório (`Meteora DBC Launchpad`) extrai só a parte DBC descrita
> aqui, num app menor e mais focado - README.md deste repo documenta o que mudou na extração
> (sem detecção de onda, formulário manual, sem sugestão por IA). O histórico de decisões e achados
> abaixo (incluindo o achado real da taxa "high tax" no GMGN) é o mesmo, só o "como se usa" muda.

# Avaliação: Meteora DBC (Dynamic Bonding Curve) pro Lançar Token Bot

Escrito em 15/09/2026, em cima do anúncio da Meteora sobre o hackathon
**Stocklana** (ações tokenizadas na Solana, $5.000 USDC pro melhor uso do
DBC - ver `hackathons.solana.com/hackathons/stocklana`). Este bot já mira
exatamente esse público (quote temático SPYx/GPRO, ver `quoteThemes.js`),
então este documento avalia trocar a bonding curve de terceiro
(StonkFun/pump.fun) por uma bonding curve NATIVA da Meteora.

## 1. Onde estamos hoje

O "Lançar Token" tem três caminhos (`launchMethod` em `tokenLauncher.js`):

| Método | Bonding curve | Pool final |
|---|---|---|
| `direct` | nenhuma - minta 100% do supply pra gente | DAMM v2 "Infinite" (`poolCreator.js`) |
| `stonkfun` | Raydium LaunchLab, via StonkFun (só SOL) | DAMM v2 "Infinite" |
| `pumpfun` | programa do pump.fun (`@pump-fun/pump-sdk`) | DAMM v2 "Infinite" |

Os dois últimos dependem de infraestrutura de terceiro pra bonding curve -
já foi a fonte de vários bugs "achados ao vivo" documentados em
`PLANO-NOVO-BOT-LANCAR-TOKEN.md` (curve rule da StonkFun, `Transaction too
large` no pump.fun, propagação de RPC entre mint e recompra). A pool final,
nos três casos, é sempre DAMM v2 via `@meteora-ag/cp-amm-sdk`
(`createInfinitePool`).

## 2. O que o DBC muda

DBC é uma bonding curve **da própria Meteora**, com migração automática pra
DAMM v2 embutida no protocolo. Ele substitui, num pacote só, a bonding curve
de terceiro (StonkFun/pump.fun) E a criação manual da pool DAMM v2
(`createInfinitePool`):

- **Lançar** = mintar o token + inicializar a curva, numa transação (SDK:
  `createPoolWithFirstBuy`, com compra inicial opcional).
- **Negociar** = qualquer um compra/vende direto na curva - ela É a
  liquidez, não precisamos comprar um quote token e parear manualmente como
  hoje.
- **Migrar** = quando a curva atinge o limiar configurado, uma pool DAMM v2
  de verdade é criada automaticamente - qualquer um pode disparar isso
  (`migrateToDammV2`), não precisa ser a gente.
- **Sacar taxa** = como somos "creator" E "partner" (dono da curva), sacamos
  dos dois lados (`claimCreatorTradingFee`/`claimPartnerTradingFee`).

Ou seja: elimina a dependência do StonkFun/pump.fun pra quem lança pela
curva, e a pool final continua sendo Meteora (DAMM v2), só que criada pelo
próprio protocolo em vez de por nós manualmente.

## 3. SDK - o que foi confirmado de verdade

`docs.meteora.ag` ficou **bloqueado pelo proxy de rede** desse ambiente -
tudo abaixo foi confirmado instalando o pacote de verdade
(`@meteora-ag/dynamic-bonding-curve-sdk@1.5.12`) num diretório à parte e
lendo o `.d.ts`/IDL publicados, não uma página resumida por IA. Onde isso
importa (ex: `DAMM_V2_MIGRATION_FEE_ADDRESS`), rodei o código real pra
confirmar o valor, não só o tipo.

```
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
const client = DynamicBondingCurveClient.create(connection, "confirmed");
```

Quatro "services" no client (equivalente ao `CpAmm` que `poolCreator.js` já
usa, só que dividido por papel):

- `client.partner` - dono do **config** (a "receita" da curva): `createConfig`,
  `createConfigAndPool`, `claimPartnerTradingFee`, `partnerWithdrawSurplus`.
- `client.creator` - dono do **pool**: `createPool`, `createPoolWithFirstBuy`,
  `claimCreatorTradingFee`, `creatorWithdrawSurplus`.
- `client.pool` - trading: `swap`, `swap2`, `swapQuote`.
- `client.migration` - `migrateToDammV2`, `createLocker`, `withdrawLeftover`.
- `client.state` - só leitura: `getPool`, `getPoolByBaseMint`,
  `getPoolQuoteTokenCurveProgress`, `getPoolFeeBreakdown`.

`buildCurve`/`buildCurveWithMarketCap` (função solta, não é método do
client) fazem a matemática de sqrtPrice/liquidez da curva - equivalente ao
`preparePoolCreationParams` que `poolCreator.js` já usa pro DAMM v2, só que
do lado do DBC. Validei rodando `buildCurve` de verdade (fora deste repo,
sem RPC) com os números do preset abaixo - a função aceita e devolve uma
curva de 2 pontos sem erro de validação.

**Achado que evita um risco real**: `migrateToDammV2` pede um `dammConfig`
(conta de config da DAMM v2 - programa DIFERENTE do "customizável" que
`poolCreator.js` usa hoje, que não precisa de config nenhum). Cheguei a
temer que isso exigisse descobrir esse endereço na mão. Não precisa: o
próprio SDK exporta `DAMM_V2_MIGRATION_FEE_ADDRESS` (array de 7 endereços
públicos, um por valor do enum `MigrationFeeOption`) - confirmei rodando o
código que os índices batem exatamente com o enum. `dbcMigration.js` usa
`DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100]` direto.

## 4. Estado atual (15/09/2026, segunda rodada) - LIGADO, mas BETA

Primeira rodada só tinha os módulos soltos (`dbcConfig.js`/`dbcLaunchpad.js`/
`dbcMigration.js`), sem ligar em nada. Essa segunda rodada liga tudo de
ponta a ponta - dá pra lançar via DBC pela própria tela - mas continua
**nunca testado com dinheiro de verdade** (ver seção 5). Nada dos métodos
`direct`/`stonkfun`/`pumpfun` foi alterado em comportamento - só adição de
branches novas, sempre gated por `launchMethod === "dbc"`/`isDbcLaunch`.

- **`src/connection.js`**: `export const dbcClient`.
- **`src/dbcConfig.js`**: presets de curva (`DBC_CURVE_PRESETS`) +
  `getOrCreateDbcConfig(presetId, quoteMint)` (cria e cacheia em
  `data/dbc-configs.json`).
- **`src/dbcLaunchpad.js`**: `launchOnDbc(...)` - minta + inicia a curva.
- **`src/dbcMigration.js`**: `getDbcCurveProgress`, `migrateDbcPoolIfReady`
  (agora também calcula e devolve `newPoolAddress` - deriva o endereço da
  pool DAMM v2 nova via `deriveDammV2PoolAddress`, exportado pelo próprio
  SDK; se a derivação falhar por qualquer motivo, NÃO reporta erro pro
  usuário - a migração em si já confirmou na transação anterior, só o
  endereço bonito fica faltando) e `claimDbcFees`.
- **`src/tokenLauncher.js`**: `launchTokenFromCandidate` ganhou
  `launchMethod: "dbc"` - branch própria que pula comprar quote/criar pool
  DAMM v2 manualmente (a curva já é liquidez) e chama `launchOnDbc`
  direto. Quote travado em SOL (mesmo motivo do StonkFun, só que aqui é
  porque os presets de curva não convertem preço entre quotes - ver
  comentário no código). Novo `export function markDbcPoolMigrated(id,
  newPoolAddress)` - atualiza o registro depois de migrar.
- **`src/server.js`**: rota de lançamento aceita `presetId`/`firstBuySolUi`
  e pula a validação de taxa/curva do DAMM v2 quando `launchMethod === "dbc"`
  (testado - regressão dos outros três métodos confirmada sem mudança de
  comportamento). Rotas novas: `GET /api/hype/dbc-presets`, `GET
  .../:id/dbc-progress`, `POST .../:id/dbc-migrate`, `POST
  .../:id/dbc-claim-fees` - todas MANUAIS (sob clique), nunca automáticas.
- **`public/index.html`/`public/hype.js`**: chip "Meteora DBC (beta)" na
  tela de lançamento (preset da curva + compra inicial opcional, em vez dos
  campos de taxa/curva do DAMM v2 que não se aplicam); avisos visuais de
  BETA + `window.confirm` extra antes de lançar; na aba Tokens Lançados,
  linhas `dbc` ganham botões "Ver progresso"/"Migrar pra DAMM v2"/"Sacar
  taxas DBC" em vez do link direto "abrir na Meteora" (a pool, antes de
  migrar, não é uma pool DAMM v2 - link separado pro Solscan até migrar).

### O que foi validado nesta rodada (sem RPC/wallet - esse ambiente não tem)

- Todos os módulos (`dbcConfig.js`, `dbcLaunchpad.js`, `dbcMigration.js`,
  `tokenLauncher.js`, `server.js`) importam sem erro com as dependências
  de verdade instaladas (`npm install` rodado, `@meteora-ag/dynamic-
  bonding-curve-sdk@1.5.12` real, não mockado).
- `node --check` limpo em todos os arquivos alterados (`.js`) e servidor
  sobe de verdade numa porta local.
- Todas as rotas HTTP novas testadas via `curl` contra o servidor rodando
  de verdade (404 correto pra token inexistente, presets retornam JSON
  válido, `launch` valida `presetId` obrigatório pra `dbc`).
- **Regressão confirmada**: os três métodos antigos (`direct`/`stonkfun`/
  `pumpfun`) continuam validando exatamente igual a antes (testei os
  mesmos erros de validação via `curl`, resultado idêntico ao pré-DBC).
- Corrigido durante essa verificação (achado ANTES de qualquer teste ao
  vivo, lendo o IDL real do SDK): a conta `virtualPool` devolvida por
  `getPool` vem envelopada num campo `poolState` (`pool.poolState.
  isMigrated`, não `pool.isMigrated` como o rascunho original tinha) -
  confirmado comparando com o uso interno do próprio SDK
  (`getPoolMigrationQuoteThreshold` usa `pool.poolState.config`).
- IDs de todo elemento novo referenciado em `hype.js` conferidos contra o
  HTML (script automatizado, sem nenhum órfão).

**O que isso NÃO prova**: nenhuma transação foi assinada/enviada de
verdade. `buildCurve`/`createConfig`/`createPoolWithFirstBuy`/
`migrateToDammV2` continuam sem confirmação em devnet/mainnet.

## 5. Riscos / o que falta antes de usar com dinheiro de verdade

1. ~~**Números da curva não validados**~~ **RESOLVIDO em 17/09/2026 (ver seção 5.4)** -
   `migrationQuoteThreshold` (antigo `migrationMarketCap`) estava em 85 SOL (placeholder do
   pump.fun); confirmado contra a config oficial da Meteora (`meteora-invent/dbc_config.jsonc`) e
   corrigido pra 10 SOL nos dois presets. `totalTokenSupply`/`percentageSupplyOnMigration` já
   batiam certo. A UI continua com aviso de BETA + confirmação extra, por cautela geral (não só
   por esse item específico).
2. **`migrationFeeOption` fixo** (`FixedBps100` = 1%) em dois arquivos
   (`dbcConfig.js` e `dbcMigration.js`) - se um dia isso virar configurável
   por preset, os dois precisam ler do mesmo lugar (hoje é uma constante
   solta em cada arquivo, de propósito simples pro primeiro corte).
3. **Nada testado com transação real.** Todo o resto do bot tem bugs reais
   documentados e corrigidos em cima de testes com dinheiro de verdade
   (`PLANO-NOVO-BOT-LANCAR-TOKEN.md`). Este código bate com a assinatura
   real do SDK instalado e passou nos smoke tests da seção 4, mas nenhuma
   transação foi assinada/enviada (esse ambiente não tem RPC/wallet).
   **Testar em devnet, com valores pequenos, antes de mainnet.**
4. **Migração/claim são manuais, de propósito** - `dbc-migrate`/
   `dbc-claim-fees` só rodam sob clique explícito na aba Tokens Lançados,
   nunca em background. Isso é uma escolha deliberada (cautela > cobertura
   automática num código não testado), não uma limitação a corrigir - se
   um dia quiser automatizar, adicionar um job é reaproveitar
   `migrateDbcPoolIfReady` como está.
5. **Quote travado em SOL** - ver comentário em `tokenLauncher.js`. Suportar
   SPYx/outros exigiria ajustar os presets pro valor de mercado de cada
   quote antes.

## 5.1. Terceira rodada (15/09/2026, madrugada) - polimento visual + validação com Playwright

Usuário foi dormir pedindo "trabalhe na perfeição" e "frontend lindo", com uma
regra clara: nada de transação real até ele acordar (nem em devnet - testei,
esse ambiente não tem saída de rede pra `api.devnet.solana.com` também, só
`docs.meteora.ag` foi bloqueado antes). Sem conseguir testar contra chain de
verdade, usei o tempo pra:

1. **`public/uiKit.js` (novo)** - toast + modal de confirmação reutilizáveis,
   estética igual ao resto do app. Substituiu TODOS os `window.alert`/
   `window.confirm` nativos que existiam na tela (os 4 que eu tinha
   acabado de adicionar pro DBC, MAIS os 2 que já existiam desde antes -
   "valor grande, tem certeza?" em `solAmountForSpyx`/`buybackSolUi`,
   achados ao vivo em 12/09/2026 - mesmo texto/comportamento, só a
   aparência mudou pra combinar com o resto do app).
2. **Saldo da wallet no topo** (`GET /api/wallet/balance`, novo) - usa
   `getWalletTokenBalance` que já existia mas não tinha rota nenhuma.
   Atualiza sozinho a cada 30s + na hora depois de qualquer ação que
   gasta/recebe SOL (lançamento, qualquer saque de taxa).
3. **Testei de verdade num navegador** (Playwright + Chromium, instalado só
   pra essa validação, sem custo) - não só `node --check`. Isso achou um
   bug REAL que a leitura do código sozinha não pegou: a célula "Pool" de
   uma linha DBC ainda não migrada tinha 3 botões que corriam juntos numa
   linha só e cortavam (herdavam `white-space: nowrap` do `<td>`) -
   corrigido com uma classe `.dbc-actions` (flex column). Também troquei o
   emoji ⚠ do pill "Meteora DBC" por texto simples ("· BETA") - emoji pode
   virar um quadrado vazio em navegador sem fonte de emoji colorida.
4. **Validei o fluxo inteiro na tela** (mock de candidato + mock de
   `fetch`, sem gastar nada): abrir modal → trocar pro chip DBC → campos
   certos aparecem/somem → confirm de BETA aparece → erro do backend
   (candidato inexistente, esperado no mock) aparece formatado certo. Fez
   uma chamada de verdade pro backend (que tentou e falhou por falta de
   rede - comportamento correto, só a rede que não existe aqui).
5. Também simulei registros de lançamento (`data/launched-tokens.json`
   temporário, **apagado depois do teste** - nunca ficou no Git, a pasta
   `data/` é ignorada) pra ver a aba Tokens Lançados com token DBC migrado,
   não migrado, e com erro - foi assim que o bug do item 3 apareceu.

**Screenshots dessa validação não foram commitados** (ficaram só no
scratchpad da sessão) - qualquer um pode reproduzir do zero seguindo o
passo 4/5 acima.

## 5.2. Quarta rodada (16/09/2026) - primeiro lançamento real + prazo do hackathon estendido

**Prazo do Stocklana estendido pra 25/09, 16h ET** (pool total subiu pra
$120k+, trilha da Meteora continua em $5.000 USDC) - dá mais tempo pra
validar com calma. Submissão é pelo próprio `hackathons.solana.com`
(auto-serviço - registro, trilha e envio tudo lá).

**Primeiro lançamento DBC de verdade, em produção**: NARWAVE, mint
`5SxgYUr6yx1QLFajnY2JHChaekCmqWJo3Di34kBBS8Ei`, em cima de um candidato
real detectado (tema "narrative", 16 tokens parecidos). Confirmou que
`createPoolWithFirstBuy`, o supply (1B, bateu exato com o preset) e o
resto da config funcionam de ponta a ponta em mainnet.

**Achado real que virou correção**: ~2min depois do lançamento, o GMGN
mostrou "⚠ Security check High tax rate now (9.83%)" - a taxa do preset
"default-2h-linear" (10% inicial, decaindo) é alta o suficiente pra
disparar o alerta automático de "high tax" que terminais de trade usam
como heurística anti-honeypot. Terminal marcando assim espanta comprador
de verdade, mesmo o token sendo legítimo. Adicionado um segundo preset,
**"baixa-taxa-2h-linear"** (3%→0,5%), validado com `buildCurve` de verdade
(sem erro) - vira o padrão selecionado na tela; o preset original continua
disponível (rotulado com o aviso), pra quem quiser comparar os dois
lançamentos lado a lado.

Isso também vira material de pitch pro hackathon - o próprio post da
Meteora convida a "reimagine tokenized stock launches with new curves,
fee models, quote assets, graduation mechanics, price discovery": esse
ciclo (lançar → observar comportamento real → ajustar o modelo de taxa)
é exatamente isso, só que baseado em dado real, não teoria.

## 5.3. Quinta rodada (17/09/2026) - segunda competição confirmada: Crypto World's Fair

Post da Meteora no Discord (17/09/2026, 09:56) anunciou uma segunda track "Best Use of Meteora
DBC", desta vez dentro do **Crypto World's Fair** da Colosseum, com sidetrack via Superteam Earn
(`superteam.fun/earn/listing/meteora-dbc`). Confirmado no navegador (X/Twitter + página do
Superteam Earn + página do Stocklana) que são **dois eventos diferentes**, não uma substituição:

| | Stocklana | Crypto World's Fair |
|---|---|---|
| Organizador | Solana Foundation | Colosseum (via Superteam Earn) |
| Prêmio da track Meteora DBC | $5.000 USDC (prêmio único) | $20.000 USDC (5 vencedores: $10k/$5k/$3k/$1,5k/$500) |
| Prazo de submissão | 25/09/2026, 16h ET | ~12/10/2026 (25 dias a partir de 17/09) |
| Anúncio dos vencedores | até 02/10/2026 | até 31/10/2026 |

A própria página do Stocklana orienta: **"Taking it further after Stocklana? Colosseum's World's
Fair is the next stop"** (`colosseum.com/worldsfair`) - confirma que não é concorrência, é
continuação. Estratégia: submeter no Stocklana no prazo (25/09) e continuar evoluindo o mesmo
código pro Crypto World's Fair antes de 12/10.

Critérios de julgamento do Crypto World's Fair (mais detalhados que o do Stocklana): profundidade
da integração com o stack Meteora, execução técnica, originalidade (se o caso de uso sobrevive ao
"meme-stock meta" atual), potencial de impacto, e tração/volume real em mainnet - reforça o
princípio já seguido aqui de "working code on mainnet beats slides". Ideias sugeridas pelo próprio
edital que valem considerar: curvas não-lineares (flat/exponential/long curve), fluxos combinando
DBC + DAMM v2 + DLMM, e um "marketplace" de presets de config DBC.

## 5.4. Sexta rodada (17/09/2026) - limiar de migração corrigido (85 SOL → 10 SOL)

Com `docs.meteora.ag`/`github.com/MeteoraAg` acessíveis (bloqueados nas rodadas anteriores),
validei de verdade o `migrationMarketCap` que a seção 5, item 1, já marcava como risco. Comparei
`dbcConfig.js` contra a config de referência oficial da própria Meteora
(`github.com/MeteoraAg/meteora-invent`, `studio/config/dbc_config.jsonc`, `buildCurveMode: 0` -
o mesmo modo que este projeto usa) e contra a tabela de "migration keepers" em
`docs.meteora.ag/developer-guides/dbc`:

- `totalTokenSupply` (1B) e `percentageSupplyOnMigration` (20%) bateram certinho com o exemplo
  oficial - nenhuma mudança necessária.
- `migrationMarketCap: 85` (SOL) estava **8,5x acima** do valor de referência oficial
  (`migrationQuoteThreshold: 10`) - confirma a suspeita antiga: "85 SOL" era mesmo só o número
  clássico de graduação do pump.fun, nunca validado pro DBC. A tabela de migration keepers também
  lista **10 SOL** como o limiar canônico pra pools cotadas em SOL. Corrigido pra 10 nos dois
  presets.
- Achado secundário: o campo `initialMarketCap` que existia nos dois presets nunca era lido em
  lugar nenhum - `buildCurve` (o modo usado aqui) só aceita `percentageSupplyOnMigration` e
  `migrationQuoteThreshold`; `initialMarketCap`/`migrationMarketCap` só existem nos modos
  `buildCurveWithMarketCap`/`buildCurveWithTwoSegments`/etc, que este projeto não usa. Campo morto,
  removido. O campo `migrationMarketCap` também foi renomeado pra `migrationQuoteThreshold` (nome
  real do parâmetro do SDK) - o nome antigo era enganoso, sugeria conversão de market cap que nunca
  existiu: o valor sempre foi um total bruto de SOL acumulado na curva.

**Efeito prático**: com o limiar em 10 SOL (era 85), a curva completa com bem menos volume real de
compra - mais fácil de alcançar migração de verdade dentro da janela do hackathon, e mais alinhado
com o critério de julgamento "Traction/Volume... prefer projects who have gone live on mainnet"
citado na seção 5.3.

**O que isso NÃO muda**: `startingFeeBps`/`endingFeeBps` dos dois presets (3%→0,5% e 10%→1%)
continuam os mesmos - esses vieram de um achado ao vivo real (GMGN/NARWAVE), não de suposição, e
não têm equivalente na config de referência genérica da Meteora pra comparar.

## 5.5. Sétima rodada (17/09/2026) - teste end-to-end real em mainnet (parcial)

Devnet estava genuinamente bloqueado no momento do teste: a RPC pública (`api.devnet.solana.com`)
recusou airdrop (limite diário do IP esgotado), o próprio `faucet.solana.com` pede explicitamente
que agentes de IA não usem o formulário web (indica CLI/PoW-faucet/validador local como
alternativa), e não havia Solana CLI nem Rust/cargo instalados nessa máquina pra rodar um
validador local com o programa DBC clonado. Diante disso, o usuário mandou 0,5 SOL de verdade pra
uma wallet de teste nova (`7cGPyHxdgMZiocrMKHXkJSaPi965Cb6wgnGmUJh4Cn1s`, gerada só pra isso,
chave só neste ambiente local em `.env`, nunca no Git) e o teste foi feito em **mainnet real, com
valor pequeno**, seguindo a mesma lógica de cautela já usada pro NARWAVE. Rodado localmente
(`npm start` contra `http://localhost:3000`, nunca contra o Railway de produção), acompanhado ao
vivo pelo usuário no navegador.

Antes disso, corrigido um gap de setup: o repo não tinha `.gitignore` nem `.env.example` (o README
já citava os dois) - adicionados ambos.

**O que foi confirmado on-chain de verdade:**

1. **`createConfig`** - config novo criado pro preset `baixa-taxa-2h-linear` (o de produção, já com
   `migrationQuoteThreshold: 10` corrigido): `BoFmVZ24TCZQ6SZV3vYNDD6yzssUwT7GbUzJsXrKTPXw`.
2. **`createPoolWithFirstBuy`** - lançamento real "DBCTEST", compra inicial 0,05 SOL: mint
   `4JJvXvCRuAuEhjg2okBqkTkBvQHGvx9Dw2RGCgSEwoxJ`, pool
   `Ey79FuyaJDjoAeAMM36uXKR345WPwAaJi4Hk75pfdXvg`. Confirma que o preset de produção corrigido
   funciona de ponta a ponta em mainnet.
3. **`getPoolQuoteTokenCurveProgress`** (leitura) - reportou 0,677% pro DBCTEST (compra de 0,05 SOL
   contra limiar de 10 SOL) - bate com o esperado.
4. **Achado real de protocolo**: tentei uma segunda compra inicial de 0,2 SOL contra um preset de
   teste (limiar 0,15 SOL) - a transação falhou na SIMULAÇÃO (sem gastar SOL) com
   `AnchorError ... InsufficientLiquidity (0x1791)`: **a compra inicial não pode ser maior que o
   `migrationQuoteThreshold` do preset** - a curva não tem liquidez pra vender além do ponto de
   migração. Isso vale pros presets de produção também (comprar >10 SOL de uma vez no lançamento
   falharia do mesmo jeito) - **o app não valida isso hoje**, fica como item novo pra seção
   "Riscos" abaixo.
5. Corrigido esse valor (0,1 SOL, abaixo do limiar de teste) e o segundo lançamento ("DBCE2E") foi
   confirmado: mint `3AvRwvoEtv5P4ZGD8siEC8tcmAHramJnmjC25w6ii5pY`, pool
   `yqkZqUEmsekYPuHfJWGZ6URWvpLZE5imhBoyRkHBFNU`.
6. **Achado real de calibração**: o progresso da curva NÃO é linear com o SOL depositado, do jeito
   que a documentação sugere ("Quote Reserve ≥ Migration Quote Threshold"). Com um limiar
   configurado de 0,15 SOL: 0,1 SOL comprado → 21,2% de progresso (não ~67% como uma razão linear
   simples sugeriria); +0,03 SOL → 29,4%; +0,1 SOL → 44,2%. Ou seja, o limiar EFETIVO real ficou
   bem mais alto que o valor configurado - provavelmente algum overhead/mínimo da curva que pesa
   proporcionalmente mais em limiares pequenos. **Implicação prática**: limiares de teste muito
   baixos (bem abaixo de 1 SOL) não são um bom proxy barato pra validar o comportamento dos
   presets de produção (10 SOL) - a essa escala maior, o overhead deve ser proporcionalmente
   desprezível, mas isso não foi confirmado de verdade (exigiria testar com os 10 SOL reais).
7. Validado incrementalmente via uma rota/botão TEMPORÁRIOS (`POST /api/test/buy-more`, usando
   `dbcClient.pool.swap` direto) - removidos do código depois do teste, não fazem parte da versão
   final.

**O que ficou sem executar de verdade** (parado por decisão consciente, não por bug): migração
(`migrateToDammV2`) e saque de taxa (`claimCreatorTradingFee`/`claimPartnerTradingFee`). Completar
a migração do pool de teste exigiria bem mais SOL do que o limiar configurado sugeria (item 6
acima) - próximo do saldo inteiro da wallet de teste, sem margem de segurança. Decisão: parar
antes de esgotar o saldo, já que essas duas funções são instruções bem mais simples (sem a
matemática de curva que era o real ponto de dúvida) e já tinham sido conferidas com cuidado contra
o IDL real do SDK numa rodada anterior (seção 3 - inclusive um bug de estrutura de dados
`pool.poolState.isMigrated` foi achado e corrigido só de ler o código, antes de qualquer teste ao
vivo). Migração de produção, de qualquer forma, é pra acontecer quando compradores reais cruzarem
o limiar de 10 SOL - não é papel do time bancar isso.

**Estado final da wallet de teste**: ~0,25 SOL restantes, mais os tokens DBCTEST/DBCE2E comprados
nas duas curvas (que podem ser revendidos de volta pra SOL via swap reverso a qualquer momento,
já que a curva funciona como AMM normal nos dois sentidos) - nada foi "perdido", só está alocado
como liquidez/posição nas duas curvas de teste.

**Achado secundário de UI**: `window.prompt()` não renderiza dentro do navegador embutido usado
pra esse teste (Claude Browser pane) - mesma classe de problema que já tinha motivado
`uiKit.js`/`confirmDialog` a substituir `window.alert`/`window.confirm` antes. Não chegou a virar
código permanente (o recurso que usava foi removido no cleanup), mas fica registrado caso um
recurso futuro precise de input de texto num modal - usar o padrão de `confirmDialog` em
`public/uiKit.js`, não `window.prompt`.

## 6. Próximos passos sugeridos

1. ~~Validar os presets de curva contra a calculadora oficial da Meteora~~ **FEITO em 17/09/2026**
   (ver seção 5.4) - `docs.meteora.ag`/`github.com/MeteoraAg` já acessíveis, `DBC_CURVE_PRESETS`
   ajustado.
2. ~~Testar o fluxo inteiro (lançar, comprar/vender, migrar, sacar taxa) com valores pequenos~~
   **PARCIALMENTE FEITO em 17/09/2026** (ver seção 5.5) - lançar + comprar + ler progresso
   confirmados em mainnet real; migrar + sacar taxa ainda não executados de verdade (só revisão de
   código/IDL).
3. Adicionar validação de que a compra inicial (`firstBuySolUi`) não excede o
   `migrationQuoteThreshold` do preset escolhido, com mensagem de erro clara - hoje só falha com o
   erro cru da simulação (achado na seção 5.5, item 4).
4. Quando um pool de produção real se aproximar do limiar de migração (compradores reais, não o
   time): acompanhar de perto o primeiro `migrateToDammV2`/`claimCreatorTradingFee` de verdade -
   ainda é a parte do ciclo nunca executada on-chain.
