'use strict';

// ============================================================
// BOT GRID MEXC — XRP 0,8% COM ~$11 USDT TOTAL (~3 x $3.70)
// ============================================================
// Capital total: ~$11 USDT (3 níveis de ~$3.70 USDT ≈ R$20 cada)
// Grid SIMÉTRICO de 0,8% para XRP na MEXC
// Toda lógica interna em USDT — BRL só para exibição
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const ccxt        = require('ccxt');
const low         = require('lowdb');
const FileSync    = require('lowdb/adapters/FileSync');
const Decimal     = require('decimal.js');
const fs          = require('fs');

require('dotenv').config();
// ──────────────────────────────────────────────────────────
// CONFIGURAÇÕES
// ──────────────────────────────────────────────────────────
const CONFIG = {
    telegramToken  : process.env.TELEGRAM_TOKEN,
    chatId         : process.env.CHAT_ID,

    MODO_SIMULADO  : true,        // Mude para false quando quiser operar de verdade
    mexcApiKey     : process.env.MEXC_API_KEY,
    mexcApiSecret  : process.env.MEXC_API_SECRET,

    scanInterval   : 10000,       // 10 segundos entre cada scan
    timeoutApi     : 20000,

    // ─── CAPITAL EM USDT ───────────────────────────────────
    // 10.41 usdt pra 3 ≈ $3.47 USDT por nível
    // Ajuste valorCamadaUSDT conforme o câmbio do dia
    valorCamadaUSDT : 3.47,       // USDT por nível (≈ R$20)
    cambioExibicao  : process.env.CAMBIO_EXIBICAO,       // Só para exibição em BRL — não afeta lógica

    // ─── GRID 0,8% SIMÉTRICO ──────────────────────────────
    spreadCompra   : 0.8,         // Compra 0,8% abaixo da referência
    spreadVenda    : 0.8,         // Vende 0,8% acima do preço de compra
    numCamadas     : 3,           // Número de níveis
    distCamadas    : 0.2,         // 0,2% de distância entre níveis

    // ─── RISCO ────────────────────────────────────────────
    maxExposicaoUSDT : 10.41,     // Exposição máxima em USDT (~3 x 3.70)
    stopDiarioUSDT   : 0.95,      // Stop loss diário (~R$5 ÷ 5.40)
    stopPorPosicao   : 1.5,       // Stop loss por posição em %

    // ─── RECALIBRAÇÃO ────────────────────────────────────
    // Recalibra a referência quando o mercado se afastar
    // mais que este % SEM posições abertas no par
    desvioRecalibraçao : 2.0,     // %

    paresDesejados: ['XRP/USDT'],

    logFile: './bot_xrp.txt',
};

// ──────────────────────────────────────────────────────────
// LOG
// ──────────────────────────────────────────────────────────
function log(msg) {
    const timestamp = new Date().toLocaleString('pt-BR');
    const linha = `[${timestamp}] ${msg}`;
    console.log(linha);
    try { fs.appendFileSync(CONFIG.logFile, linha + '\n'); } catch (e) {}
}

// ──────────────────────────────────────────────────────────
// BANCO DE DADOS
// ──────────────────────────────────────────────────────────
const adapter = new FileSync('grid_mexc_xrp.json');
const db = low(adapter);
const hoje = new Date().toLocaleDateString('pt-BR');

db.defaults({
    posicoes   : {},
    execucoes  : [],
    referencias: {},
    stats      : {
        compras: 0, vendas: 0,
        lucroUSDT: 0, prejuizoUSDT: 0,
        ciclos: 0, updatedAt: null,
    },
    perdaHojeUSDT : 0,
    dataHoje      : hoje,
}).write();

// ──────────────────────────────────────────────────────────
// TELEGRAM
// ──────────────────────────────────────────────────────────
const bot = new TelegramBot(CONFIG.telegramToken, {
    polling: { interval: 2000, autoStart: true, params: { timeout: 10 } },
});

bot.on('polling_error', err => log(`[TG ERROR] ${err.message}`));

function tg(chatId, txt) {
    return bot.sendMessage(chatId, txt).catch(e => log(`[TG FAIL] ${e.message}`));
}

// ──────────────────────────────────────────────────────────
// CONEXÃO MEXC
// ──────────────────────────────────────────────────────────
let exchange = null;

async function initMexc() {
    if (CONFIG.MODO_SIMULADO) {
        log('[MODO SIMULADO] Conectando virtualmente...');
        return true;
    }
    try {
        exchange = new ccxt.mexc({
            apiKey: CONFIG.mexcApiKey,
            secret: CONFIG.mexcApiSecret,
            enableRateLimit: true,
            timeout: CONFIG.timeoutApi,
            options: { defaultType: 'spot' },
        });
        const balance = await exchange.fetchBalance();
        log(`[MEXC] Conectado! USDT livre: ${balance.USDT?.free || 0}`);
        return true;
    } catch (err) {
        log(`[MEXC] Erro ao conectar: ${err.message}`);
        return false;
    }
}

// ──────────────────────────────────────────────────────────
// BUSCAR PREÇOS
// ──────────────────────────────────────────────────────────
async function buscarPrecos() {
    const tempExchange = new ccxt.mexc({
        enableRateLimit: true,
        timeout: CONFIG.timeoutApi,
    });

    const precos = {};

    for (const par of CONFIG.paresDesejados) {
        try {
            const ticker = await tempExchange.fetchTicker(par);
            if (ticker && ticker.last) {
                precos[par] = {
                    par,
                    preco : ticker.last,
                    bid   : ticker.bid,
                    ask   : ticker.ask,
                    fonte : 'MEXC',
                    ts    : new Date().toISOString(),
                };
                const brl = (ticker.last * CONFIG.cambioExibicao).toFixed(4);
                log(`[PREÇO] ${par} = ${ticker.last} USDT (≈ R$ ${brl})`);
            }
        } catch (err) {
            log(`[ERRO PREÇO] ${par}: ${err.message}`);
        }
    }

    return precos;
}

// ──────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────
const D   = n  => new Decimal(n || 0);
const now = () => new Date().toISOString();
const ptBR = dt => new Date(dt).toLocaleString('pt-BR');
const f   = (n, d = 4) => parseFloat(n || 0).toFixed(d);

// Exposição total em USDT somando todas as posições abertas
function exposicaoAtual() {
    return Object.values(db.get('posicoes').value())
        .reduce((s, p) => s + (p.valorUSDT || 0), 0);
}

// Posições abertas de um par específico
function posicoesDoPar(par) {
    return Object.values(db.get('posicoes').value()).filter(p => p.par === par);
}

// Gera os níveis de compra/venda a partir de um preço de referência
function gerarNiveis(precoRef) {
    const niveis = [];
    for (let i = 1; i <= CONFIG.numCamadas; i++) {
        // Cada nível fica distCamadas% mais fundo que o anterior
        const pctAbaixo  = D(CONFIG.spreadCompra).plus(D(CONFIG.distCamadas).times(i - 1));
        const precoCompra = D(precoRef).times(D(1).minus(pctAbaixo.div(100))).toNumber();
        // Alvo de venda: 0,8% acima do preço de compra daquele nível
        const precoVenda  = D(precoCompra).times(D(1).plus(D(CONFIG.spreadVenda).div(100))).toNumber();
        niveis.push({ nivel: i, precoCompra, precoVenda, pctAbaixo: pctAbaixo.toNumber() });
    }
    return niveis;
}

// ──────────────────────────────────────────────────────────
// EXECUTAR ORDEM (valores em USDT)
// ──────────────────────────────────────────────────────────
async function executarOrdem(par, tipo, precoUSDT, valorUSDT) {
    const quantidade = parseFloat(D(valorUSDT).div(precoUSDT).toFixed(6));

    if (CONFIG.MODO_SIMULADO) {
        log(`✅ [SIMULADO] ${tipo.toUpperCase()} ${par} $${f(valorUSDT, 2)} USDT (${quantidade} @ ${precoUSDT})`);
        return { id: `sim_${Date.now()}`, preco: precoUSDT, quantidade, status: 'closed' };
    }

    try {
        let ordem;
        if (tipo === 'compra') {
            ordem = await exchange.createLimitBuyOrder(par, quantidade, precoUSDT);
        } else {
            ordem = await exchange.createLimitSellOrder(par, quantidade, precoUSDT);
        }
        log(`✅ [REAL] ${tipo.toUpperCase()} ${par} $${f(valorUSDT, 2)} USDT @ ${precoUSDT}`);
        return { id: ordem.id, preco: ordem.price, quantidade: ordem.amount, status: ordem.status };
    } catch (err) {
        log(`❌ [ERRO ORDEM] ${tipo} ${par}: ${err.message}`);
        return null;
    }
}

// ──────────────────────────────────────────────────────────
// ABRIR POSIÇÃO
// ──────────────────────────────────────────────────────────
async function abrirOrdem(par, nivel, precoCompra, precoVenda, pctAbaixo) {
    const posicoes = db.get('posicoes').value();
    const key = `${par}__N${nivel}`;

    // Já existe posição neste nível?
    if (posicoes[key]) return null;

    // Limite de exposição total
    if (exposicaoAtual() + CONFIG.valorCamadaUSDT > CONFIG.maxExposicaoUSDT + 0.01) {
        log(`[SKIP N${nivel}] Exposição máxima atingida`);
        return null;
    }

    const resultado = await executarOrdem(par, 'compra', precoCompra, CONFIG.valorCamadaUSDT);
    if (!resultado) return null;

    // Stop: preço cai stopPorPosicao% abaixo do preço de compra
    const alvoStop = D(precoCompra)
        .times(D(1).minus(D(CONFIG.stopPorPosicao).div(100)))
        .toNumber();

    const qtd = D(CONFIG.valorCamadaUSDT).div(precoCompra).toNumber();

    const pos = {
        par, nivel, pctAbaixo,
        precoCompra,
        precoVenda,
        alvoStop,
        qtd,                              // quantidade em XRP
        valorUSDT : CONFIG.valorCamadaUSDT,
        aberto    : now(),
        orderId   : resultado.id,
    };

    posicoes[key] = pos;
    db.set('posicoes', posicoes).write();

    const brl = (precoCompra * CONFIG.cambioExibicao).toFixed(4);
    log(`📦 [ABRIR] ${par} N${nivel} @ ${f(precoCompra, 6)} USDT (≈ R$${brl}) | Stop @ ${f(alvoStop, 6)}`);
    return pos;
}

// ──────────────────────────────────────────────────────────
// FECHAR POSIÇÃO
// ──────────────────────────────────────────────────────────
async function fecharPosicao(key, pos, precoAtual, motivo) {
    const posicoes = db.get('posicoes').value();

    const resultado = await executarOrdem(pos.par, 'venda', precoAtual, pos.valorUSDT);
    if (!resultado) return null;

    // Lucro/prejuízo em USDT puro
    const recebidoUSDT = D(pos.qtd).times(precoAtual).toNumber();
    const lucroUSDT    = D(recebidoUSDT).minus(pos.valorUSDT).toNumber();
    const lucroBRL     = lucroUSDT * CONFIG.cambioExibicao;

    const fechado = {
        tipo        : 'VENDA',
        motivo,
        par         : pos.par,
        nivel       : pos.nivel,
        precoCompra : pos.precoCompra,
        precoVenda  : precoAtual,
        valorUSDT   : pos.valorUSDT,
        lucroUSDT,
        lucroBRL,
        orderId     : resultado.id,
    };

    // Remove posição
    delete posicoes[key];
    db.set('posicoes', posicoes).write();

    const emoji = lucroUSDT >= 0 ? '💰' : '📉';
    const sg    = lucroUSDT >= 0 ? '+' : '';
    log(`${emoji} [${motivo}] ${pos.par} N${pos.nivel} ${sg}$${f(lucroUSDT, 4)} USDT (${sg}R$${f(lucroBRL, 2)})`);

    // ── RECALIBRAÇÃO PÓS-FECHAMENTO ──────────────────────
    // Se não há mais posições abertas neste par, move a
    // referência para o preço atual para o próximo ciclo
    const restantes = posicoesDoPar(pos.par);
    if (restantes.length === 0) {
        const refs = db.get('referencias').value();
        refs[pos.par] = { preco: precoAtual, ts: now() };
        db.set('referencias', refs).write();
        log(`📌 [RECALIBRA] ${pos.par} nova ref = ${f(precoAtual, 6)} USDT`);
    }

    return fechado;
}

// ──────────────────────────────────────────────────────────
// VERIFICAR FECHAMENTOS (alvo ou stop)
// ──────────────────────────────────────────────────────────
async function verificarFechamentos(par, precoAtual) {
    const posicoes = db.get('posicoes').value();
    const fechados = [];

    for (const [key, pos] of Object.entries(posicoes)) {
        if (pos.par !== par) continue;

        const atingiuAlvo = precoAtual >= pos.precoVenda;
        const atingiuStop = precoAtual <= pos.alvoStop;

        if (atingiuAlvo) log(`  🎯 ALVO N${pos.nivel}: ${f(precoAtual, 6)} >= ${f(pos.precoVenda, 6)}`);
        if (atingiuStop) log(`  🛑 STOP N${pos.nivel}: ${f(precoAtual, 6)} <= ${f(pos.alvoStop, 6)}`);

        if (!atingiuAlvo && !atingiuStop) continue;

        const fechado = await fecharPosicao(key, pos, precoAtual, atingiuAlvo ? 'ALVO' : 'STOP');
        if (fechado) fechados.push(fechado);
    }

    return fechados;
}

// ──────────────────────────────────────────────────────────
// ATUALIZAR ESTATÍSTICAS
// ──────────────────────────────────────────────────────────
function atualizarStats(compras, fechados) {
    const s = db.get('stats').value();
    let perdaHoje = db.get('perdaHojeUSDT').value();

    s.compras += compras.length;

    for (const ex of fechados) {
        s.vendas++;
        if (ex.lucroUSDT >= 0) {
            s.lucroUSDT = D(s.lucroUSDT).plus(ex.lucroUSDT).toNumber();
            s.ciclos++;
        } else {
            const p = Math.abs(ex.lucroUSDT);
            s.prejuizoUSDT = D(s.prejuizoUSDT).plus(p).toNumber();
            perdaHoje = D(perdaHoje).plus(p).toNumber();
        }
    }

    s.updatedAt = ptBR(new Date());
    db.set('stats', s).write();
    db.set('perdaHojeUSDT', perdaHoje).write();

    // Histórico de execuções
    const todos = [
        ...compras.map(c => ({ ...c, tipo: 'COMPRA', lucroUSDT: 0, lucroBRL: 0 })),
        ...fechados,
    ];
    for (const ex of todos) {
        db.get('execucoes').unshift({ ...ex, ts: now() }).write();
    }

    // Mantém só as últimas 500
    const hist = db.get('execucoes').value();
    if (hist.length > 500) db.set('execucoes', hist.slice(0, 500)).write();

    return perdaHoje;
}

// ──────────────────────────────────────────────────────────
// ENVIAR ALERTAS TELEGRAM
// ──────────────────────────────────────────────────────────
async function enviarAlertas(compras, fechados) {
    for (const c of compras) {
        const brlC = (c.precoCompra * CONFIG.cambioExibicao).toFixed(4);
        const brlV = (c.precoVenda  * CONFIG.cambioExibicao).toFixed(4);
        await tg(CONFIG.chatId,
            `🟢 COMPRA ${c.par} N${c.nivel}\n` +
            `Preço: ${f(c.precoCompra, 6)} USDT (≈ R$${brlC})\n` +
            `Alvo:  ${f(c.precoVenda,  6)} USDT (≈ R$${brlV})\n` +
            `Stop:  ${f(c.alvoStop,    6)} USDT\n` +
            `Valor: $${f(c.valorUSDT, 2)} USDT`
        );
    }

    for (const ex of fechados) {
        const sg = ex.lucroUSDT >= 0 ? '+' : '';
        await tg(CONFIG.chatId,
            `${ex.lucroUSDT >= 0 ? '✅' : '❌'} ${ex.motivo} ${ex.par} N${ex.nivel}\n` +
            `Compra: ${f(ex.precoCompra, 6)} → Venda: ${f(ex.precoVenda, 6)} USDT\n` +
            `Resultado: ${sg}$${f(ex.lucroUSDT, 4)} USDT (${sg}R$${f(ex.lucroBRL, 2)})`
        );
    }
}

// ──────────────────────────────────────────────────────────
// LOOP PRINCIPAL
// ──────────────────────────────────────────────────────────
async function loop() {
    // Reset diário
    const diaAtual = new Date().toLocaleDateString('pt-BR');
    if (db.get('dataHoje').value() !== diaAtual) {
        db.set('perdaHojeUSDT', 0).set('dataHoje', diaAtual).write();
        log('📅 [RESET] Novo dia — perda diária zerada');
    }

    // Stop diário atingido?
    if (db.get('perdaHojeUSDT').value() >= CONFIG.stopDiarioUSDT) {
        log(`⛔ [STOP DIÁRIO] Perda $${f(db.get('perdaHojeUSDT').value(), 2)} >= limite $${CONFIG.stopDiarioUSDT}`);
        return;
    }

    log(`\n🔍 [SCAN] ${ptBR(new Date())}`);

    // Busca preços
    const precos = await buscarPrecos();
    const par = 'XRP/USDT';
    if (!precos[par]) return;

    const precoAtual = precos[par].preco;

    // ── REFERÊNCIA E RECALIBRAÇÃO ─────────────────────────
    let refs = db.get('referencias').value();

    if (!refs[par]) {
        refs[par] = { preco: precoAtual, ts: now() };
        db.set('referencias', refs).write();
        log(`📌 [REF INICIAL] ${par} = ${f(precoAtual, 6)} USDT`);
    }

    const precoRef = refs[par].preco;
    const diffPct  = ((precoAtual - precoRef) / precoRef) * 100;
    const diffAbs  = Math.abs(diffPct);

    // Recalibração proativa: mercado se afastou muito sem posições abertas
    if (diffAbs > CONFIG.desvioRecalibraçao && posicoesDoPar(par).length === 0) {
        refs[par] = { preco: precoAtual, ts: now() };
        db.set('referencias', refs).write();
        log(`📌 [RECALIBRA] Desvio ${diffAbs.toFixed(2)}% > ${CONFIG.desvioRecalibraçao}% sem posições → nova ref ${f(precoAtual, 6)}`);
    }

    const precoRefAtual = db.get('referencias').value()[par].preco;
    const niveis = gerarNiveis(precoRefAtual);

    log(`📊 [GRID] ${par} atual:${f(precoAtual, 6)} ref:${f(precoRefAtual, 6)} diff:${diffPct.toFixed(3)}%`);

    // Exibe os níveis calculados
    log('📐 Níveis:');
    for (const n of niveis) {
        const brlC = (n.precoCompra * CONFIG.cambioExibicao).toFixed(4);
        const brlV = (n.precoVenda  * CONFIG.cambioExibicao).toFixed(4);
        log(`  N${n.nivel} (${n.pctAbaixo}% abaixo): Compra ${f(n.precoCompra, 6)} (R$${brlC}) → Venda ${f(n.precoVenda, 6)} (R$${brlV})`);
    }

    // ── VERIFICAR VENDAS (antes de abrir novas compras) ───
    const todosFechados = await verificarFechamentos(par, precoAtual);

    // ── VERIFICAR COMPRAS ─────────────────────────────────
    const todasCompras = [];
    for (const n of niveis) {
        if (precoAtual <= n.precoCompra) {
            log(`  📉 Preço ${f(precoAtual, 6)} <= N${n.nivel} (${f(n.precoCompra, 6)}) → abrindo`);
            const pos = await abrirOrdem(par, n.nivel, n.precoCompra, n.precoVenda, n.pctAbaixo);
            if (pos) todasCompras.push(pos);
        }
    }

    // ── ATUALIZA STATS E ALERTAS ──────────────────────────
    const perdaHoje = atualizarStats(todasCompras, todosFechados);

    if (todasCompras.length > 0 || todosFechados.length > 0) {
        await enviarAlertas(todasCompras, todosFechados);
    }

    // Resumo no log
    const s   = db.get('stats').value();
    const sld = D(s.lucroUSDT).minus(s.prejuizoUSDT).toNumber();
    const sldBRL = sld * CONFIG.cambioExibicao;
    log(
        `📈 [STATS] Ciclos:${s.ciclos} C:${s.compras} V:${s.vendas} | ` +
        `Saldo:$${f(sld, 4)} USDT (R$${f(sldBRL, 2)}) | ` +
        `Exp:$${f(exposicaoAtual(), 2)}/$${CONFIG.maxExposicaoUSDT} USDT | ` +
        `PerdaHoje:$${f(perdaHoje, 4)}/$${CONFIG.stopDiarioUSDT}`
    );
}

// ──────────────────────────────────────────────────────────
// COMANDOS TELEGRAM
// ──────────────────────────────────────────────────────────
bot.onText(/\/start/, msg => tg(msg.chat.id,
    '🤖 BOT GRID XRP 0,8% — MEXC\n\n' +
    `Capital: ~$${CONFIG.maxExposicaoUSDT} USDT (${CONFIG.numCamadas} x $${CONFIG.valorCamadaUSDT})\n` +
    `Spread compra: ${CONFIG.spreadCompra}% abaixo\n` +
    `Spread venda:  ${CONFIG.spreadVenda}% acima\n` +
    `Stop/posição:  ${CONFIG.stopPorPosicao}%\n` +
    `Stop diário:   $${CONFIG.stopDiarioUSDT} USDT\n` +
    `Recalibração:  >${CONFIG.desvioRecalibraçao}% sem posição\n\n` +
    'Comandos:\n' +
    '/status — estatísticas\n' +
    '/posicoes — posições abertas\n' +
    '/grid — níveis atuais\n' +
    '/execucoes — últimas operações\n' +
    '/config — configurações'
));

bot.onText(/\/status/, msg => {
    const s   = db.get('stats').value();
    const pos = db.get('posicoes').value();
    const pd  = db.get('perdaHojeUSDT').value();
    const exp = exposicaoAtual();
    const sld = D(s.lucroUSDT).minus(s.prejuizoUSDT).toNumber();

    tg(msg.chat.id,
        `📊 ESTATÍSTICAS\n\n` +
        `Ciclos completos: ${s.ciclos}\n` +
        `Compras: ${s.compras} | Vendas: ${s.vendas}\n` +
        `Lucro:    $${f(s.lucroUSDT, 4)} USDT\n` +
        `Prejuízo: $${f(s.prejuizoUSDT, 4)} USDT\n` +
        `Saldo:    $${f(sld, 4)} USDT (R$${f(sld * CONFIG.cambioExibicao, 2)})\n\n` +
        `Posições abertas: ${Object.keys(pos).length}/${CONFIG.numCamadas}\n` +
        `Exposição: $${f(exp, 2)}/$${CONFIG.maxExposicaoUSDT} USDT\n` +
        `Perda hoje: $${f(pd, 4)}/$${CONFIG.stopDiarioUSDT} USDT\n` +
        `Atualizado: ${s.updatedAt || '—'}`
    );
});

bot.onText(/\/posicoes/, msg => {
    const pos = db.get('posicoes').value();
    if (Object.keys(pos).length === 0) {
        return tg(msg.chat.id, '📭 Nenhuma posição aberta');
    }

    let txt = '📦 POSIÇÕES ABERTAS:\n\n';
    for (const p of Object.values(pos)) {
        const brlC = (p.precoCompra * CONFIG.cambioExibicao).toFixed(4);
        const brlV = (p.precoVenda  * CONFIG.cambioExibicao).toFixed(4);
        const brlS = (p.alvoStop    * CONFIG.cambioExibicao).toFixed(4);
        txt += `${p.par} N${p.nivel} (${p.pctAbaixo}% abaixo)\n`;
        txt += `  Compra: ${f(p.precoCompra, 6)} USDT (R$${brlC})\n`;
        txt += `  Alvo:   ${f(p.precoVenda,  6)} USDT (R$${brlV})\n`;
        txt += `  Stop:   ${f(p.alvoStop,    6)} USDT (R$${brlS})\n`;
        txt += `  Qtd:    ${f(p.qtd, 4)} XRP | $${f(p.valorUSDT, 2)} USDT\n`;
        txt += `  Aberto: ${ptBR(p.aberto)}\n\n`;
    }
    tg(msg.chat.id, txt);
});

bot.onText(/\/grid/, msg => {
    const refs = db.get('referencias').value();
    if (!refs['XRP/USDT']) return tg(msg.chat.id, '⚠️ Sem referência ainda. Aguarde o próximo scan.');

    const precoRef = refs['XRP/USDT'].preco;
    const niveis   = gerarNiveis(precoRef);
    const refBRL   = (precoRef * CONFIG.cambioExibicao).toFixed(4);

    let txt = `📐 GRID ATUAL — XRP 0,8%\n\n`;
    txt += `Referência: ${f(precoRef, 6)} USDT (R$${refBRL})\n`;
    txt += `Atualizada: ${ptBR(refs['XRP/USDT'].ts)}\n\n`;

    for (const n of niveis) {
        const brlC = (n.precoCompra * CONFIG.cambioExibicao).toFixed(4);
        const brlV = (n.precoVenda  * CONFIG.cambioExibicao).toFixed(4);
        txt += `N${n.nivel} (${n.pctAbaixo}% abaixo):\n`;
        txt += `  Compra: ${f(n.precoCompra, 6)} USDT (R$${brlC})\n`;
        txt += `  Venda:  ${f(n.precoVenda,  6)} USDT (R$${brlV})\n\n`;
    }
    tg(msg.chat.id, txt);
});

bot.onText(/\/execucoes/, msg => {
    const lista = db.get('execucoes').value().slice(0, 10);
    if (!lista.length) return tg(msg.chat.id, '📭 Nenhuma execução ainda');

    let txt = '📜 ÚLTIMAS 10 EXECUÇÕES:\n\n';
    for (const e of lista) {
        txt += `${e.tipo === 'COMPRA' ? '🟢' : '🔴'} ${e.tipo} ${e.par} N${e.nivel}`;
        if (e.tipo === 'VENDA') {
            const sg = e.lucroUSDT >= 0 ? '+' : '';
            txt += ` ${sg}$${f(e.lucroUSDT, 4)} (${e.motivo})`;
        }
        txt += `\n   ${ptBR(e.ts)}\n\n`;
    }
    tg(msg.chat.id, txt);
});

bot.onText(/\/config/, msg => tg(msg.chat.id,
    `⚙️ CONFIGURAÇÕES\n\n` +
    `Capital: $${CONFIG.maxExposicaoUSDT} USDT total\n` +
    `${CONFIG.numCamadas} níveis de $${CONFIG.valorCamadaUSDT} USDT\n` +
    `Spread compra: ${CONFIG.spreadCompra}%\n` +
    `Spread venda:  ${CONFIG.spreadVenda}%\n` +
    `Dist. níveis:  ${CONFIG.distCamadas}%\n` +
    `Stop/posição:  ${CONFIG.stopPorPosicao}%\n` +
    `Stop diário:   $${CONFIG.stopDiarioUSDT} USDT\n` +
    `Recalibração:  >${CONFIG.desvioRecalibraçao}% sem posição\n` +
    `Par: ${CONFIG.paresDesejados[0]}\n` +
    `Câmbio exibição: R$${CONFIG.cambioExibicao}`
));



// ──────────────────────────────────────────────────────────
// START
// ──────────────────────────────────────────────────────────
log('='.repeat(70));
log('  BOT GRID XRP 0,8% — MEXC SPOT');
log(`  Capital: $${CONFIG.maxExposicaoUSDT} USDT | ${CONFIG.numCamadas} níveis de $${CONFIG.valorCamadaUSDT}`);
log(`  Spread: ${CONFIG.spreadCompra}% compra | ${CONFIG.spreadVenda}% venda`);
log(`  Stop: ${CONFIG.stopPorPosicao}%/posição | $${CONFIG.stopDiarioUSDT} USDT/dia`);
log(`  Recalibração automática: >${CONFIG.desvioRecalibraçao}% sem posição`);
log(`  Modo: ${CONFIG.MODO_SIMULADO ? 'SIMULADO' : 'REAL'}`);
log('='.repeat(70));

(async () => {
    const conectado = await initMexc();

    if (conectado) {
        await tg(CONFIG.chatId,
            `🤖 BOT GRID XRP INICIADO!\n\n` +
            `💰 Capital: $${CONFIG.maxExposicaoUSDT} USDT total\n` +
            `📊 ${CONFIG.numCamadas} níveis de $${CONFIG.valorCamadaUSDT} USDT\n` +
            `📉 Compra: ${CONFIG.spreadCompra}% abaixo\n` +
            `📈 Venda:  ${CONFIG.spreadVenda}% acima\n` +
            `🛑 Stop:   ${CONFIG.stopPorPosicao}% | $${CONFIG.stopDiarioUSDT}/dia\n` +
            `🔄 Recalibra: >${CONFIG.desvioRecalibraçao}% sem posição\n\n` +
            `✅ Modo ${CONFIG.MODO_SIMULADO ? 'SIMULADO' : 'REAL'} ativo\n` +
            `📱 /status /posicoes /grid /execucoes`
        );

        log('✅ Bot iniciado com sucesso!');

        // Primeira execução imediata, depois a cada scanInterval
        await loop();
        setInterval(loop, CONFIG.scanInterval);
    } else {
        log('❌ Falha ao conectar. Verifique as credenciais.');
        tg(CONFIG.chatId, '❌ Erro ao conectar na MEXC. Verifique API Key.');
    }
})();
