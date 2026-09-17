# Meteora DBC Launchpad

Submissão pra trilha **Meteora** de dois hackathons, com o mesmo código:

1. **Stocklana** (`hackathons.solana.com/hackathons/stocklana`) - track "Best Use of Meteora DBC",
   $5.000 USDC, prazo **25/09/2026, 16h ET** (estendido).
2. **Crypto World's Fair** (Colosseum, via Superteam Earn - `superteam.fun/earn/listing/meteora-dbc`) -
   track "Best use of Meteora DBC", $20.000 USDC entre 5 vencedores ($10k/$5k/$3k/$1,5k/$500), prazo
   **~12/10/2026** (vencedores anunciados até 31/10/2026).

A própria página do Stocklana aponta o Crypto World's Fair como continuação natural ("Taking it
further after Stocklana? Colosseum's World's Fair is the next stop") - não são concorrentes entre si,
dá pra submeter no Stocklana primeiro e evoluir o mesmo projeto pro Crypto World's Fair depois.

Extraído do [Lançar Token Bot](https://github.com/alemaxxx/lauch-token) - um bot maior que detecta
ondas de hype no StonkFun/pump.fun e lança tokens em cima delas. Esse projeto aqui é só a parte
**Meteora DBC** (Dynamic Bonding Curve), sem a detecção de onda: um formulário direto - nome,
símbolo, imagem, preset de curva - e o resto é automático até a curva estar pronta pra migrar.

## O que faz

1. **Lança um token na curva** (`createPoolWithFirstBuy` do SDK oficial) - minta o token e inicializa
   a bonding curve numa transação só. A curva já É a liquidez: qualquer um compra/vende assim que
   o token existe, sem precisar de nenhuma compra inicial do criador (opcional).
2. **Acompanha o progresso** da curva - quanto falta pra atingir o limiar de migração do preset
   escolhido.
3. **Migra pra uma pool DAMM v2 de verdade**, sob clique explícito, quando a curva completar - nunca
   automático.
4. **Saca as taxas de negociação** acumuladas (creator + partner - a wallet configurada é as duas
   partes).

Nada disso acontece sozinho: cada ação (lançar, migrar, sacar) exige um clique + confirmação
explícita. Sem gerador de volume, sem detecção de onda, sem sugestão de nome/imagem por IA - só o
fluxo DBC.

## Achado real (16/09/2026)

O primeiro lançamento de teste (mint `5SxgYUr6yx1QLFajnY2JHChaekCmqWJo3Di34kBBS8Ei`, feito no
Lançar Token Bot original antes desse recorte existir) usou uma taxa inicial de 10% - e ~2 minutos
depois o GMGN (terminal de trade) marcou o token com "Security check — High tax rate now (9.83%)":
taxa alta o suficiente pra disparar a heurística anti-honeypot que scanners de terminal usam,
espantando comprador de verdade mesmo o token sendo legítimo. Por isso os dois presets em
`src/dbcConfig.js`:

| Preset | Taxa (inicial → final, 2h) | Observação |
|---|---|---|
| `baixa-taxa-2h-linear` (padrão) | 3% → 0,5% | abaixo do limiar que costuma disparar alerta |
| `default-2h-linear` | 10% → 1% | disparou "high tax" no GMGN - mantido pra comparação |

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencha RPC_URL e WALLET_PRIVATE_KEY
npm start
```

Abre em `http://localhost:3000`.

## Variáveis de ambiente

Só duas obrigatórias - ver `.env.example`. Nenhum valor real deve ir pro Git. Em produção
(Railway), cole os valores direto no painel de variáveis do serviço.

## O que já foi testado em mainnet de verdade (17/09/2026)

Com uma wallet de teste isolada (não a de produção): `createConfig`, `createPoolWithFirstBuy` (com
o preset de produção já corrigido) e leitura de progresso da curva - todos confirmados on-chain.
Migração e saque de taxa ainda não foram executados de verdade (só revisão de código/IDL) - ver
seção 5.5 do `PLANO-DBC-MIGRACAO.md` pro relato completo, incluindo dois achados reais de
protocolo: (1) a compra inicial não pode exceder o limiar de migração do preset (a curva não tem
liquidez além desse ponto), e (2) o progresso da curva não é linear com o SOL depositado - limiares
de teste muito baixos (bem abaixo de 1 SOL) não são um bom proxy barato pros presets de produção.

## O que ainda falta validar

- **Migração e saque de taxa** (`migrateToDammV2`/`claimCreatorTradingFee`/`claimPartnerTradingFee`)
  - nunca executados com transação real ainda (ver acima).
- **Validação client/server-side de que a compra inicial não excede o limiar de migração** - hoje
  só falha com o erro cru da simulação on-chain.
- **Quote travado em SOL** - os presets definem o limiar em unidades do próprio quote token, sem
  converter preço; suportar outro quote (USDC, um xStock) exigiria calibrar os presets pro valor de
  mercado de cada um antes.

Ver `PLANO-DBC-MIGRACAO.md` pro histórico completo de decisões e achados (herdado do projeto
original, com o que é específico deste recorte adicionado no topo).
