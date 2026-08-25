require("dotenv").config();
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, AttachmentBuilder } = require("discord.js");
const { Pool } = require('pg');
const Stripe = require('stripe');
const express = require('express');
const fetch = require('node-fetch');
const { JWT } = require('google-auth-library');

// ====================== BLINDAGEM DE VARIÁVEIS AMBIENTAIS ======================
const rawKey = process.env.GOOGLE_PRIVATE_KEY;
const rawEmail = process.env.GOOGLE_CLIENT_EMAIL;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Vendas";
const CLIENT_PROFILE_SHEET = process.env.CLIENT_PROFILE_SHEET || "Clientes";
const REFUND_SHEET_NAME = process.env.REFUND_SHEET_NAME || "Reembolsos";

// Diagnóstico preciso de variáveis faltantes
if (!rawKey && !rawEmail) {
    console.error(" CRITICAL: BOTH GOOGLE_PRIVATE_KEY and GOOGLE_CLIENT_EMAIL are missing!");
    process.exit(1);
} else if (!rawKey) {
    console.error("🔴 CRITICAL: GOOGLE_PRIVATE_KEY is missing!");
    process.exit(1);
} else if (!rawEmail) {
    console.error(" CRITICAL: GOOGLE_CLIENT_EMAIL is missing!");
    process.exit(1);
}

if (!SPREADSHEET_ID) {
    console.error(" CRITICAL: SPREADSHEET_ID is missing from environment variables!");
    process.exit(1);
}

// Reconstrução forçada do PEM para evitar erro DECODER routines::unsupported
let cleanKey = rawKey
    .replace(/\\n/g, '\n')          // Converte \n literais vindos de JSON/env
    .replace(/\r\n/g, '\n')         // Normaliza CRLF
    .replace(/[^\S\r\n]+/g, '')     // Remove espaços/tabs entre linhas
    .trim();                        // Remove espaços nas pontas

// Reconstrói o PEM garantindo quebras de linha exatas e removendo marcadores duplicados/corrompidos
const keyLines = cleanKey.split('\n').filter(line => line.trim() !== '');
const bodyLines = keyLines.filter(line => 
    !line.includes('-----BEGIN') && !line.includes('-----END')
);
cleanKey = '-----BEGIN PRIVATE KEY-----\n' + 
           bodyLines.join('\n') + 
           '\n-----END PRIVATE KEY-----';

// Validação de integridade PEM
if (!cleanKey.includes('-----BEGIN PRIVATE KEY-----') || 
    !cleanKey.includes('-----END PRIVATE KEY-----')) {
    console.error("🔴 CRITICAL: GOOGLE_PRIVATE_KEY format is corrupted after reconstruction.");
    console.error("   Start:", cleanKey.substring(0, 30));
    process.exit(1);
}

const SERVICE_ACCOUNT_KEY = {
    client_email: rawEmail.trim(),
    private_key: cleanKey
};

// Logs de verificação absoluta
console.log("DEBUG GOOGLE_KEY:", rawKey ? "PRESENT (Length: " + rawKey.length + ")" : "MISSING");
console.log(" AUTH EMAIL:", SERVICE_ACCOUNT_KEY.client_email);
console.log("🔐 KEY LENGTH:", SERVICE_ACCOUNT_KEY.private_key.length);
console.log("DEBUG KEY START:", SERVICE_ACCOUNT_KEY.private_key.substring(0, 30));
console.log("DEBUG KEY END:", SERVICE_ACCOUNT_KEY.private_key.substring(SERVICE_ACCOUNT_KEY.private_key.length - 30));
// ==============================================================================

// ====================== ESTADO GLOBAL & CONFIGURAÇÕES ======================
let isMaintenanceMode = false;
let isStripeDisabled = false; // Novo interruptor para desativar Stripe
const DEV_IDS = ["721614093269729292", "971051392456331324", "1356140129865175221"];
const SHOWCASE_FORUM_ID = "1512933679448457348";
const PORTFOLIO_CHANNEL_ID = "1538751620064485487";
const ID_MICSCARR = "721614093269729292";
const ID_POLYPIE = "971051392456331324";
const ID_OCCULTSIDE_OFFICIAL = "1356140129865175221";

// Cache de cotação USD com fallback seguro
let usdBrlCache = { rate: null, timestamp: 0 };
const CACHE_DURATION = 5 * 60 * 1000;

async function getUsdBrlRate() {
    try {
        const now = Date.now();
        if (usdBrlCache.rate && (now - usdBrlCache.timestamp) < CACHE_DURATION) return usdBrlCache.rate;
        
        const response = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL');
        const data = await response.json();
        
        // Verifica se a propriedade USDBRL existe antes de acessar .bid
        if (!data.USDBRL || !data.USDBRL.bid) {
            throw new Error("API returned invalid structure");
        }
        
        const rate = parseFloat(data.USDBRL.bid);
        usdBrlCache = { rate, timestamp: now };
        return rate;
    } catch (err) {
        console.error("Erro ao buscar cotação USD:", err.message);
        return usdBrlCache.rate || 5.40; 
    }
}

async function getJwtClient() {
    const jwtClient = new JWT({
        email: SERVICE_ACCOUNT_KEY.client_email,
        key: SERVICE_ACCOUNT_KEY.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    await jwtClient.authorize();
    return jwtClient;
}

function formatBrasiliaDate(dateObj) {
    if (!dateObj) dateObj = new Date();
    const d = String(dateObj.getDate()).padStart(2, '0');
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const y = dateObj.getFullYear();
    const h = String(dateObj.getHours()).padStart(2, '0');
    const min = String(dateObj.getMinutes()).padStart(2, '0');
    const s = String(dateObj.getSeconds()).padStart(2, '0');
    return `${d}/${m}/${y} ${h}:${min}:${s}`;
}
// ====================== FUNÇÃO AUXILIAR: NOTIFICAÇÃO DISTRIBUÍDA ======================
async function sendApprovalEmbed(store, embed, components, approvalKey) {
    let owners = [];
    if (store === 'occult') owners = [ID_MICSCARR];
    else if (store === 'side') owners = [ID_POLYPIE];
    else if (store === 'occult_x_side') owners = [ID_MICSCARR, ID_POLYPIE];
    
    if (!owners.includes(ID_OCCULTSIDE_OFFICIAL)) owners.push(ID_OCCULTSIDE_OFFICIAL);

    const sentMessages = [];
    for (const ownerId of owners) {
        try {
            const user = await client.users.fetch(ownerId);
            const msg = await user.send({ embeds: [embed], components: components });
            sentMessages.push({ channelId: msg.channel.id, messageId: msg.id });
        } catch (e) {
            console.error(`Failed to send approval embed to ${ownerId}:`, e.message);
        }
    }
    if (pendingApprovals[approvalKey]) {
        pendingApprovals[approvalKey].messageRefs = sentMessages;
    }
}

async function invalidateApprovalButtons(approvalData, actionText) {
    if (!approvalData || !approvalData.messageRefs) return;
    for (const ref of approvalData.messageRefs) {
        try {
            const channel = await client.channels.fetch(ref.channelId);
            const msg = await channel.messages.fetch(ref.messageId);
            await msg.edit({ content: actionText, embeds: msg.embeds, components: [] });
        } catch (e) { /* ignore */ }
    }
}

// ====================== FUNÇÃO DE PORTFÓLIO ======================
async function sendToPortfolio(product, buyerId) {
    try {
        const forumChannel = client.channels.cache.get(PORTFOLIO_CHANNEL_ID);
        if (!forumChannel) return;
        
        const embed = new EmbedBuilder()
            .setTitle(`${product.id}`)
            .setDescription(`This item has been acquired and is now part of our portfolio.`)
            .setImage(product.image)
            .setColor(0x2ecc71)
            .setFooter({ text: "Unavailable • Sold Item" })
            .setTimestamp();
            
        const thread = await forumChannel.threads.create({
            name: `${product.id}`,
            message: { embeds: [embed] },
            autoArchiveDuration: 10080,
            reason: `Product ${product.id} sold and moved to portfolio.`
        });
    } catch (err) {
        console.error("❌ Error sending to portfolio:", err.message);
    }
}

// ====================== LÓGICA DE RELATÓRIOS (CORRIGIDA E DINÂMICA) ======================
async function generateReportMetrics(store, type) {
    const now = new Date();
    let titlePrefix = "";
    let referenceDateStr = "";
    
    // Definir período para filtro manual (já que vamos ler a planilha inteira e filtrar aqui)
    let cutoffDate = new Date();
    if (type === 'daily') {
        cutoffDate.setHours(cutoffDate.getHours() - 24);
        referenceDateStr = `Últimas 24h (até ${now.toLocaleTimeString('pt-BR')})`;
        titlePrefix = "Resumo Diário";
    } else if (type === 'monthly') {
        cutoffDate.setDate(cutoffDate.getDate() - 30);
        referenceDateStr = "Últimos 30 dias";
        titlePrefix = "Resumo Mensal";
    } else if (type === 'yearly') {
        cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);
        referenceDateStr = "Último Ano";
        titlePrefix = "Resumo Anual";
    }

    try {
        const jwtClient = await getJwtClient();
        
        // 1. Buscar TODOS os dados da aba de Vendas
        const salesRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A:R`, { 
            headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}` } 
        });
        const salesData = await salesRes.json();
        const salesRows = salesData.values || [];
        
        // Mapear cabeçalhos para saber qual coluna é qual
        const headers = salesRows[0] || [];
        const colMap = {};
        headers.forEach((h, i) => { if(h) colMap[h.trim()] = i; });
        
        // Índices importantes baseados na sua planilha
        const idxStore = colMap['Loja'] ?? 1;
        const idxStatus = colMap['Status'] ?? 4;
        const idxPrice = colMap['Valor Pago'] ?? 12; // Coluna M
        const idxDate = colMap['Data Venda'] ?? 15; // Coluna P
        const idxProdId = colMap['ID Produto'] ?? 0;

        let itemsSold = 0;
        let revenueUsd = 0;
        let soldProductsList = [];

        // Filtrar linhas manualmente
        for (let i = 1; i < salesRows.length; i++) {
            const row = salesRows[i];
            if (!row || row.length === 0) continue;

            const rowStore = row[idxStore] ? row[idxStore].replace('🛒 ', '').trim().toLowerCase() : '';
            const rowStatus = row[idxStatus] ? row[idxStatus].trim() : '';
            
            // Verificar Loja
            let storeMatch = false;
            if (store === 'all') storeMatch = true;
            else if (store === 'occult_x_side' && rowStore.includes('occult_x_side')) storeMatch = true;
            else if (rowStore === store) storeMatch = true;

            if (!storeMatch) continue;

            // Verificar Status (Apenas vendidos)
            if (!rowStatus.includes('Vendido') && !rowStatus.includes('🔴')) continue;

            // Verificar Data
            let dateValid = false;
            if (row[idxDate]) {
                // Formato esperado na planilha: DD/MM/AAAA HH:mm:ss
                const parts = row[idxDate].split(' ');
                if (parts[0]) {
                    const [d, m, y] = parts[0].split('/').map(Number);
                    const [h, min, s] = parts[1] ? parts[1].split(':').map(Number) : [0,0,0];
                    const saleDate = new Date(y, m - 1, d, h, min, s);
                    
                    if (saleDate >= cutoffDate && saleDate <= now) {
                        dateValid = true;
                        
                        // Somar Receita
                        let priceVal = 0;
                        if (row[idxPrice]) {
                            // Limpar formatação "$109.09"
                            const cleanPrice = row[idxPrice].toString().replace('$', '').replace(',', '.');
                            priceVal = parseFloat(cleanPrice) || 0;
                        }
                        revenueUsd += priceVal;
                        itemsSold++;
                        
                        // Adicionar à lista de produtos vendidos recentes
                        soldProductsList.push({
                            id: row[idxProdId],
                            price: `$${priceVal.toFixed(2)}`,
                            created_at: saleDate
                        });
                    }
                }
            }
        }

        // 2. Tráfego e Novos Usuários (Estes continuam vindo do DB pois a planilha não registra cliques/novos usuários facilmente)
        // Mantemos a lógica original do DB para estas métricas específicas, pois são mais complexas de rastrear só pela planilha de vendas
        
        let intervalSql = "";
        if (type === 'daily') intervalSql = `NOW() - INTERVAL '24 hours'`;
        else if (type === 'monthly') intervalSql = `NOW() - INTERVAL '30 days'`;
        else if (type === 'yearly') intervalSql = `NOW() - INTERVAL '1 year'`;

        let storeFilter = store === 'all' ? '' : `AND store = '${store}'`;
        
        // Cliques
        const clicksRes = await pool.query(`SELECT COUNT(*) as count FROM product_interactions WHERE interacted_at >= ${intervalSql} ${storeFilter}`);
        const totalClicks = parseInt(clicksRes.rows[0].count) || 0;

        // Expirações
        const expRes = await pool.query(`SELECT COUNT(*) as count FROM product_reservations WHERE status = 'EXPIRED' AND expires_at >= ${intervalSql} ${storeFilter}`);
        const expirations = parseInt(expRes.rows[0].count) || 0;

        // Top Visitados sem venda (Lógica complexa, mantemos do DB)
        const topRes = await pool.query(`
            SELECT pi.product_id, COUNT(*) as views 
            FROM product_interactions pi 
            LEFT JOIN partnership_approvals pa ON pi.product_id = pa.product_id AND pa.status = 'APPROVED' AND pa.created_at >= ${intervalSql.replace('created_at', 'pa.created_at')}
            WHERE pi.interacted_at >= ${intervalSql.replace('created_at', 'pi.interacted_at')} 
              AND pa.id IS NULL 
              ${store === 'all' ? '' : `AND pi.store = '${store}'`}
            GROUP BY pi.product_id 
            ORDER BY views DESC LIMIT 3
        `);

        // Novos Usuários
        const newUsersRes = await pool.query(`SELECT COUNT(*) as count FROM customers WHERE created_at >= ${intervalSql.replace('created_at', 'customers.created_at')}`);
        const newUsers = parseInt(newUsersRes.rows[0].count) || 0;

        return { 
            itemsSold, 
            revenueUsd, 
            totalClicks, 
            expirations, 
            topProducts: topRes.rows, 
            newUsers, 
            soldProducts: soldProductsList, // Usando a lista extraída da planilha
            titlePrefix, 
            referenceDateStr 
        };

    } catch (err) {
        console.error("Erro ao gerar métricas do relatório:", err);
        // Fallback para zeros se der erro na planilha
        return { 
            itemsSold: 0, revenueUsd: 0, totalClicks: 0, expirations: 0, 
            topProducts: [], newUsers: 0, soldProducts: [],
            titlePrefix, referenceDateStr 
        };
    }
}

function buildReportEmbed(metrics, storeName) {
    const embed = new EmbedBuilder()
        .setTitle(`📊 ${metrics.titlePrefix} - ${storeName}`)
        .setDescription(`Referente a: ${metrics.referenceDateStr}`)
        .setColor(0x3498db)
        .addFields(
            { name: '💰 Vendas', value: `• Total Vendido: **${metrics.itemsSold} itens**\n• Receita: **$${metrics.revenueUsd.toFixed(2)} USD**`, inline: false },
            { name: '📈 Tráfego & Interesse', value: `• Cliques em Produtos: **${metrics.totalClicks} acessos**\n• Expiraram na Fila: **${metrics.expirations} pessoas**`, inline: false },
            { name: '👥 Clientes', value: `• Novos Usuários: **${metrics.newUsers}**`, inline: false }
        );

    // Correção aqui: Verifica se o preço é string ou objeto antes de tentar formatar
    if (metrics.soldProducts.length > 0) {
        const soldList = metrics.soldProducts.map(p => {
            let val = '$?';
            
            // Se for string (vem da planilha), usa direto. Se for objeto (vem do DB), extrai o valor.
            if (typeof p.price === 'string') {
                val = p.price; 
            } else if (typeof p.price === 'object' && p.price !== null) {
                val = p.price.basic_stripe || '$?';
            } else {
                val = `$${p.price}`;
            }
            
            return `• \`${p.id}\` (${val})`;
        }).join('\n');
        
        embed.addFields({ name: '🛍️ Produtos Vendidos (Recentes)', value: soldList.substring(0, 1024), inline: false });
    }

    if (metrics.topProducts.length > 0) {
        let topStr = metrics.topProducts.map((p, i) => `${i+1}. \`${p.product_id}\` (${p.views} cliques)`).join('\n');
        embed.addFields({ name: '🔥 Top 3 Mais Visitados (Sem Compra)', value: `${topStr}\n*💡 Insight: Itens populares sem venda. Verifique preço.*`, inline: false });
    } else {
        embed.addFields({ name: '🔥 Top 3 Mais Visitados (Sem Compra)', value: 'Nenhum registro.', inline: false });
    }

    return embed;
}

// Relatorio Automatico Diario (00:00)
function scheduleDailyReport() {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    const timeUntilMidnight = nextMidnight.getTime() - now.getTime();
    setTimeout(async () => {
        await sendDailyReports();
        scheduleDailyReport();
    }, timeUntilMidnight);
}

async function sendDailyReports() {
    console.log("📊 Gerando relatórios diários automáticos...");
    try {
        const metricsOccult = await generateReportMetrics('occult', 'daily');
        const metricsSide = await generateReportMetrics('side', 'daily');
        const metricsAll = await generateReportMetrics('all', 'daily');

        try { await client.users.fetch(ID_MICSCARR).then(u => u.send({ embeds: [buildReportEmbed(metricsOccult, 'Occult Store')] })); } catch(e){}
        try { await client.users.fetch(ID_POLYPIE).then(u => u.send({ embeds: [buildReportEmbed(metricsSide, 'Side Store')] })); } catch(e){}
        try { await client.users.fetch(ID_OCCULTSIDE_OFFICIAL).then(u => u.send({ embeds: [buildReportEmbed(metricsAll, 'Occult x Side')] })); } catch(e){}
        
        console.log("✅ Relatórios diários enviados.");
    } catch (err) {
        console.error("❌ Erro relatórios:", err);
    }
}

// ====================== FUNÇÕES DE PLANILHA ======================
async function updateClientProfileSheet(userId, username, tier, storeOfPurchase, purchaseAmount) {
    try {
        const jwtClient = await getJwtClient();
        
        // 1. Buscar dados atuais da planilha para ver se usuário já existe
        const fullRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CLIENT_PROFILE_SHEET)}!A:K`, { 
            headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}` } 
        });
        const fullData = await fullRes.json();
        const rows = fullData.values || [];
        
        let targetRowIndex = -1;
        let currentTotalPurchases = 0; // Variável para guardar o total atual da planilha

        // Procura pelo ID do usuário na coluna A (índice 0)
        for (let i = 1; i < rows.length; i++) { 
            if (rows[i][0] === userId) { 
                targetRowIndex = i + 1; 
                // Pega o valor atual da coluna D (Índice 3 é a coluna D, que é Total de Compras)
                // Se existir um número, converte, senão assume 0
                currentTotalPurchases = parseInt(rows[i][3]) || 0;
                break; 
            } 
        }

        // Coletar outros dados atualizados do Banco de Dados (Créditos, Risco, etc)
        const creditsOccult = await getCreditBalance(userId, 'occult');
        const creditsSide = await getCreditBalance(userId, 'side');
        const creditsOXS = await getCreditBalance(userId, 'occult_x_side');
        
        const refundRes = await pool.query(`SELECT COUNT(*) FROM support_tickets WHERE user_id = $1 AND status = 'PENDING'`, [userId]);
        const pendingRefunds = parseInt(refundRes.rows[0].count);
        
        // Para o Ticket Médio, ainda usamos o DB para precisão financeira, mas o Total de Compras vem da Planilha + 1
        const historyRes = await pool.query(`SELECT s.product_id, p.price FROM partnership_approvals s JOIN products p ON s.product_id = p.id WHERE s.user_id = $1 AND s.status = 'APPROVED'`, [userId]);
        
        let totalSpent = 0;
        historyRes.rows.forEach(row => { 
            const priceObj = typeof row.price === 'string' ? JSON.parse(row.price) : row.price; 
            totalSpent += parseFloat(priceObj.basic_stripe?.replace('$', '') || 0); 
        });

        // CORREÇÃO PRINCIPAL: Incrementa o total que já estava na planilha
        const newTotalPurchases = currentTotalPurchases + 1;
        
        const avgTicket = newTotalPurchases > 0 ? `$${(totalSpent / newTotalPurchases).toFixed(2)}` : '$0.00';
        
        const riskRes = await pool.query(`SELECT COUNT(*) FROM support_tickets WHERE user_id = $1 AND status IN ('DENIED', 'PENDING')`, [userId]);
        const riskStatus = parseInt(riskRes.rows[0].count) >= 3 ? '🚫 High Risk' : '✅ Normal';
        
        const tierDisplay = tier === 'premium' ? '💎 Premium' : '🌟 Basic';
        const lastPurchaseDate = formatBrasiliaDate(new Date()); // Usa a data atual da venda

        if (targetRowIndex !== -1) {
            // Atualizar linha existente
            const updates = [
                { range: `${CLIENT_PROFILE_SHEET}!C${targetRowIndex}`, values: [[tierDisplay]] }, 
                { range: `${CLIENT_PROFILE_SHEET}!D${targetRowIndex}`, values: [[newTotalPurchases]] }, // Salva o novo total
                { range: `${CLIENT_PROFILE_SHEET}!E${targetRowIndex}`, values: [[lastPurchaseDate]] }, 
                { range: `${CLIENT_PROFILE_SHEET}!F${targetRowIndex}`, values: [[`$${creditsOccult.toFixed(2)}`]] },
                { range: `${CLIENT_PROFILE_SHEET}!G${targetRowIndex}`, values: [[`$${creditsSide.toFixed(2)}`]] }, 
                { range: `${CLIENT_PROFILE_SHEET}!H${targetRowIndex}`, values: [[`$${creditsOXS.toFixed(2)}`]] },
                { range: `${CLIENT_PROFILE_SHEET}!I${targetRowIndex}`, values: [[pendingRefunds]] }, 
                { range: `${CLIENT_PROFILE_SHEET}!J${targetRowIndex}`, values: [[riskStatus]] }, 
                { range: `${CLIENT_PROFILE_SHEET}!K${targetRowIndex}`, values: [[avgTicket]] }
            ];
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, { 
                method: 'POST', 
                headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) 
            });
        } else {
            // Criar nova linha (Primeira compra)
            const newRow = [
                userId, 
                username, 
                tierDisplay, 
                1, // Começa com 1
                lastPurchaseDate, 
                `$${creditsOccult.toFixed(2)}`, 
                `$${creditsSide.toFixed(2)}`, 
                `$${creditsOXS.toFixed(2)}`, 
                pendingRefunds, 
                riskStatus, 
                avgTicket
            ];
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(CLIENT_PROFILE_SHEET)}!A:K:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { 
                method: 'POST', 
                headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ values: [newRow] }) 
            });
        }
    } catch (err) { 
        console.error("Error updating client profile sheet:", err.message); 
    }
}

async function addProductToSheet(product, netAmountUsd) {
    try {
        const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price;
        const jwtClient = await getJwtClient();
        const currentRate = await getUsdBrlRate();
        const netAmountBrl = netAmountUsd * currentRate;
        const formattedDate = formatBrasiliaDate(new Date());

        // Formatação correta de preços para a planilha
        const priceStripeFormatted = prices.basic_stripe.replace('$', '').trim().replace('.', ',');
        let cleanLindens = prices.basic_lindens.replace(/L\$|,/g, '').trim();
        // Garante formato correto sem ",00" solto se já tiver vírgula
        if (!cleanLindens.includes(',')) cleanLindens += ',00';

        const rowValues = [
            product.id, 
            `🛒 ${product.store.toUpperCase()}`, 
            formattedDate, 
            product.image || '', 
            '🟢 Disponível', 
            'Discord', 
            netAmountBrl.toFixed(2).replace('.', ','), 
            priceStripeFormatted, 
            cleanLindens, 
            '', '', '', '', '', '', '', '', ''
        ];

        console.log(`Adding product ${product.id} to sheet...`);
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A:R:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { 
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}`, 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ values: [rowValues] }) 
        });
        console.log(`✅ Product ${product.id} added to sheet successfully.`);
    } catch (err) { 
        console.error("❌ Error registering product in sheet:", err.message); 
    }
}

async function updateSaleInSheet(productId, buyerId, paymentMethod, checkoutUrl, platform = '🟣 Discord', creditsUsed = 0, totalPaid = 0) {
    try {
        // 1. Arquivar produto no DB
        await pool.query('UPDATE products SET archived = TRUE WHERE id = $1', [productId]);

        const jwtClient = await getJwtClient();
        
        // 2. Buscar dados atuais da planilha
        const fullRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A:R`, { 
            headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}` } 
        });
        const fullData = await fullRes.json();
        const rows = fullData.values || [];

        // 3. Mapear cabeçalhos para encontrar índices das colunas
        const headers = rows[0] || [];
        const headerMap = {};
        headers.forEach((h, i) => { if (h) headerMap[h.trim()] = i; });
        
        const statusColIndex = headerMap['Status'] ?? 4;
        const launchColIndex = headerMap['Data Lançamento'] ?? 2;

        // 4. Encontrar a linha do produto (Busca case-insensitive e trim)
        let rowIndex = -1;
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] && rows[i][0].toString().trim() === productId.toString().trim()) {
                // Verifica se ainda está disponível
                const status = rows[i][statusColIndex] ? rows[i][statusColIndex].toString().trim() : '';
                if (status.includes('Disponível') || status.includes('🟢')) {
                    rowIndex = i;
                    break;
                }
            }
        }

        if (rowIndex === -1) {
            console.warn(`⚠️ Product ${productId} not found in sheet as Available. It might be already sold or ID mismatch.`);
            // Tentativa de fallback: se não achou como disponível, verifica se existe arquivado para não duplicar, mas avisa.
            const existsAnywhere = rows.some((r, i) => i > 0 && r[0] === productId);
            if (!existsAnywhere) {
                 console.error(`❌ CRITICAL: Product ${productId} does not exist in Sheet at all. Sales data will be lost in Sheet.`);
            }
            return;
        }

        const sheetRowIndex = rowIndex + 1; // Sheets é base 1
        const currentRow = rows[rowIndex];

        // 5. Obter dados do comprador
        let buyerName = 'Unknown', buyerTier = '🌟 Basic';
        try {
            const user = await client.users.fetch(buyerId);
            buyerName = user.username;
            const custRes = await pool.query(`SELECT tier FROM customers WHERE user_id = $1`, [buyerId]);
            if (custRes.rows.length > 0) buyerTier = custRes.rows[0].tier === 'premium' ? '💎 Premium' : '🌟 Basic';
        } catch (e) {}

        // 6. Calcular Tempo de Giro
        let turnoverTime = '0h 0m';
        const launchStr = currentRow[launchColIndex];
        if (launchStr) {
            const [datePart, timePart] = launchStr.split(' ');
            if (datePart && timePart) {
                const [d, m, y] = datePart.split('/').map(Number);
                const [h, min, s] = timePart.split(':').map(Number);
                const launchDate = new Date(y, m - 1, d, h, min, s);
                const diffMs = new Date().getTime() - launchDate.getTime();
                if (diffMs > 0) {
                    const totalMinutes = Math.floor(diffMs / 60000); 
                    const totalHours = Math.floor(diffMs / 3600000); 
                    const totalDays = Math.floor(diffMs / 86400000);
                    if (totalDays >= 1) turnoverTime = `${totalDays}d ${totalHours % 24}h`; 
                    else if (totalHours >= 1) turnoverTime = `${totalHours}h ${totalMinutes % 60}m`; 
                    else turnoverTime = `${totalMinutes}m`;
                }
            }
        }

        // 7. Definir Emoji do Método de Pagamento
        let methodEmoji = paymentMethod;
        if (creditsUsed > 0 && paymentMethod === 'Stripe') methodEmoji = '💳 Credits + Stripe'; 
        else if (creditsUsed > 0 && paymentMethod === 'Lindens') methodEmoji = '💳 Credits + L$'; 
        else if (paymentMethod === 'Credits') methodEmoji = '💳 Credits'; 
        else if (paymentMethod === 'Stripe') methodEmoji = '💵 Stripe'; 
        else if (paymentMethod === 'Lindens') methodEmoji = '💎 Lindens';

        const saleDate = formatBrasiliaDate(new Date());

        // 8. Atualizar Colunas Específicas
        const updates = [
            { range: `${SHEET_NAME}!E${sheetRowIndex}`, values: [['🔴 Vendido']] }, 
            { range: `${SHEET_NAME}!J${sheetRowIndex}`, values: [[buyerName]] }, 
            { range: `${SHEET_NAME}!K${sheetRowIndex}`, values: [[buyerId]] },
            { range: `${SHEET_NAME}!L${sheetRowIndex}`, values: [[buyerTier]] }, 
            { range: `${SHEET_NAME}!M${sheetRowIndex}`, values: [[totalPaid > 0 ? `$${totalPaid.toFixed(2)}` : '']] }, 
            { range: `${SHEET_NAME}!N${sheetRowIndex}`, values: [[creditsUsed > 0 ? `$${creditsUsed.toFixed(2)}` : '']] },
            { range: `${SHEET_NAME}!O${sheetRowIndex}`, values: [[methodEmoji]] }, 
            { range: `${SHEET_NAME}!P${sheetRowIndex}`, values: [[saleDate]] }, 
            { range: `${SHEET_NAME}!Q${sheetRowIndex}`, values: [[checkoutUrl || '']] }, 
            { range: `${SHEET_NAME}!R${sheetRowIndex}`, values: [[turnoverTime]] }
        ];

        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, { 
            method: 'POST', 
            headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}`, 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) 
        });

        console.log(`✅ Sale updated in Sheet for ${productId}`);

        // 9. Atualizar Perfil do Cliente na outra aba
        updateClientProfileSheet(buyerId, buyerName, buyerTier === '💎 Premium' ? 'premium' : 'basic', '', totalPaid).catch(e => {});

    } catch (err) { 
        console.error("❌ CRITICAL Error updating sale in sheet: ", err.message); 
    }
}

async function logRefundToSheet(userId, username, store, productId, amount, method, reason, analystName = '') {
    try {
        const jwtClient = await getJwtClient();
        const rowValues = [
            formatBrasiliaDate(new Date()),
            username,
            userId,
            store.toUpperCase(),
            productId,
            `$${amount.toFixed(2)}`,
            method === 'credit' ? 'Store Credit' : 'Original Currency',
            reason.substring(0, 500),
            '⏳ Pending',
            analystName
        ];

        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(REFUND_SHEET_NAME)}!A:J:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [rowValues] })
        });
    } catch (err) {
        console.error("❌ Error logging refund to sheet:", err.message);
    }
}

async function updateRefundStatusInSheet(ticketId, newStatus, analystName) {
    try {
        const jwtClient = await getJwtClient();
        const fullRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(REFUND_SHEET_NAME)}!A:J`, {
            headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}` }
        });
        const rows = (await fullRes.json()).values || [];
        let targetRowIndex = -1;

        // Busca pela última linha pendente ou pelo ID do usuário/produto se possível
        for (let i = rows.length - 1; i >= 1; i--) {
             if (rows[i][8] && rows[i][8].includes('Pending')) { 
                 targetRowIndex = i + 1;
                 break;
             }
        }

        if (targetRowIndex !== -1) {
            const updates = [
                { range: `${REFUND_SHEET_NAME}!I${targetRowIndex}`, values: [[newStatus]] }, 
                { range: `${REFUND_SHEET_NAME}!J${targetRowIndex}`, values: [[analystName]] }
            ];
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`, { 
                method: 'POST', 
                headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) 
            });
        }
    } catch (err) { 
        console.error("Error updating refund status in sheet: ", err.message); 
    }
}

// ====================== CONFIGURAÇÕES MULTI-LOJA & LOGS ======================
// Cria apenas os clientes que possuem chave válida. 
// Se a chave não existir, usa null para não travar o boot do bot.

console.log("===== STRIPE ENV DIAGNOSTIC =====");

console.log(
    Object.keys(process.env)
        .filter(k => k.includes("STRIPE"))
        .sort()
);

console.log(
    "SIDE SECRET:",
    process.env.STRIPE_SECRET_KEY_SIDE
        ? "PRESENT"
        : "MISSING"
);

console.log(
    "SIDE WEBHOOK:",
    process.env.STRIPE_WEBHOOK_SECRET_SIDE
        ? "PRESENT"
        : "MISSING"
);

console.log("================================");
const stripeClients = {
    occult: process.env.STRIPE_SECRET_KEY_OCCULT ? new Stripe(process.env.STRIPE_SECRET_KEY_OCCULT) : null,
    side: process.env.STRIPE_SECRET_KEY_SIDE ? new Stripe(process.env.STRIPE_SECRET_KEY_SIDE) : null,
    occult_x_side: process.env.STRIPE_SECRET_KEY_OXS ? new Stripe(process.env.STRIPE_SECRET_KEY_OXS) : null
};

// Verifica se pelo menos a loja principal está ativa
// ... código existente ...
if (!stripeClients.occult) {
    console.error("🔴 CRITICAL: STRIPE_SECRET_KEY_OCCULT is missing. Bot cannot start.");
    process.exit(1);
} else {
    console.log("✅ Stripe Client initialized for: OCCULT");
    if (stripeClients.side) console.log("✅ Stripe Client initialized for: SIDE");
    if (stripeClients.occult_x_side) console.log("✅ Stripe Client initialized for: OCCULTSIDE");
}

// 👇 ADICIONE ESTE BLOCO AQUI 👇
console.log("🔍 DEBUG SIDE KEY:", process.env.STRIPE_SECRET_KEY_SIDE ? "PRESENT (" + process.env.STRIPE_SECRET_KEY_SIDE.substring(0, 10) + "...)" : "MISSING/NULL");
console.log("🔍 DEBUG SIDE CLIENT:", stripeClients.side ? "INITIALIZED" : "NULL");
// ----------------------------------

const WEBHOOK_SECRETS = {
    occult: process.env.STRIPE_WEBHOOK_SECRET_OCCULT,
    side: process.env.STRIPE_WEBHOOK_SECRET_SIDE || 'temp', // Valor temporário para não dar undefined
    occult_x_side: process.env.STRIPE_WEBHOOK_SECRET_OXS || 'temp'
};

const LOG_CONFIG = {
    guildId: process.env.LOG_GUILD_ID,
    activeCategoryId: process.env.LOG_CATEGORY_ACTIVE,
    archiveCategoryId: process.env.LOG_CATEGORY_ARCHIVE,
    storePrefixes: { occult: "1-OCC ", side: "2-SID ", occult_x_side: "3-OXS " }
};

const SESSION_TIMEOUT = 20 * 60 * 1000;
const PAYMENT_SELECTION_TIMEOUT = 3 * 60 * 1000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20, min: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    allowExitOnIdle: false
});
pool.on('error', (err) => console.log("️ DB unstable:", err.message));

Promise.all([
    pool.query(  `CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, store TEXT NOT NULL, price JSONB, image TEXT, file_download TEXT, tech_images TEXT[], stripe_product_id TEXT, stripe_price_basic_id TEXT, stripe_price_premium_id TEXT, archived BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW(), showcase_post_id TEXT)`  ),
    pool.query(  `CREATE TABLE IF NOT EXISTS customers (user_id TEXT PRIMARY KEY, tier TEXT DEFAULT 'basic', purchase_dates TIMESTAMP[] DEFAULT '{}', first_premium_notified BOOLEAN DEFAULT FALSE, stripe_coupon_id TEXT, created_at TIMESTAMP DEFAULT NOW(), log_key_occult TEXT, log_key_side TEXT, log_key_occult_x_side TEXT, last_log_activity TIMESTAMP DEFAULT NOW())`  ),
    pool.query(  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS blocked_stores TEXT[] DEFAULT '{}'`  ),
    pool.query(  `CREATE TABLE IF NOT EXISTS partnership_approvals (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL, store TEXT NOT NULL, payment_method TEXT NOT NULL, receipt_url TEXT, status TEXT DEFAULT 'PENDING', approved_by TEXT, created_at TIMESTAMP DEFAULT NOW())`  ),
    pool.query(  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`  ),
    pool.query(  `INSERT INTO settings (key, value) VALUES ('linden_rate', '244') ON CONFLICT DO NOTHING`  ),
    pool.query(  `CREATE TABLE IF NOT EXISTS product_reservations (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL, store TEXT NOT NULL, reserved_at TIMESTAMP DEFAULT NOW(), expires_at TIMESTAMP NOT NULL, status TEXT DEFAULT 'ACTIVE')`  ),
    pool.query(  `CREATE TABLE IF NOT EXISTS queue_notifications (user_id TEXT NOT NULL, product_id TEXT NOT NULL, notified BOOLEAN DEFAULT FALSE, joined_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (user_id, product_id))`  ),
    pool.query(  `CREATE TABLE IF NOT EXISTS customer_credits (user_id TEXT NOT NULL, store TEXT NOT NULL, balance NUMERIC DEFAULT 0, updated_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (user_id, store))`  ),
    pool.query(  `ALTER TABLE customer_credits ADD COLUMN IF NOT EXISTS refund_credit_balance NUMERIC DEFAULT 0`  ),
    pool.query(  `CREATE TABLE IF NOT EXISTS support_tickets (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, user_id TEXT NOT NULL, store TEXT NOT NULL, type TEXT NOT NULL, reason TEXT, method TEXT, status TEXT DEFAULT 'PENDING', created_at TIMESTAMP DEFAULT NOW())`  ),
    pool.query(  `CREATE TABLE IF NOT EXISTS product_interactions (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL, store TEXT NOT NULL, interacted_at TIMESTAMP DEFAULT NOW(), CONSTRAINT unique_interaction UNIQUE (user_id, product_id))`  ),
    pool.query(  `CREATE TABLE IF NOT EXISTS admin_audit_logs (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, admin_id TEXT NOT NULL, target_user_id TEXT NOT NULL, action TEXT NOT NULL, old_value TEXT, new_value TEXT, reason TEXT, timestamp TIMESTAMP DEFAULT NOW())`  )
]).then(() => {
    console.log(  " Tables  & Functions ready!  ");
    scheduleDailyReport();
}).catch(err => console.error(  " DB Init Error:  ", err));

setInterval(async () => {
    try {
        const expired = await pool.query(`UPDATE product_reservations SET status = 'EXPIRED' WHERE status IN ('ACTIVE', 'SITE_RESERVATION') AND expires_at < NOW() RETURNING *`);
        for (const res of expired.rows) await notifyNextInQueue(res.product_id, res.store);
    } catch (err) {
        console.error("Reservation cleanup job error:", err.message);
    }
}, 60000);

async function getNextId(store) {
    const prefix = store === "occult" ? "#OCCSET" : store === "side" ? "#SIDSET" : "#OCCXSIDSET";
    const res = await pool.query(`SELECT COUNT(*) FROM products WHERE store = $1`, [store]);
    return `${prefix}${String(parseInt(res.rows[0].count) + 1).padStart(2, "0")}`;
}

async function syncShowcase(product) {
    try {
        const forumChannel = client.channels.cache.get(SHOWCASE_FORUM_ID);
        if (!forumChannel) return;

        if (product.archived) {
            if (product.showcase_post_id) {
                try { 
                    const t = await forumChannel.threads.fetch(product.showcase_post_id).catch(() => null); 
                    if (t) await t.delete(); 
                } catch (e) {}
                await pool.query(`UPDATE products SET showcase_post_id = NULL WHERE id = $1`, [product.id]);
            }
            return;
        }

        const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price;
        const embed = new EmbedBuilder()
            .setTitle(`${product.id}`)
            .setDescription(`💳 **Stripe:** ${prices.basic_stripe}\n💎 **Lindens:** ${prices.basic_lindens}`)
            .setImage(product.image)
            .setColor(0xFFD700)
            .setFooter({ text: "Click the button below to start your purchase via DM! " });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel("🛒 Buy via DM ").setStyle(ButtonStyle.Primary).setCustomId(`showcase_buy_${product.id.replace(/ /g, '_')}`)
        );

        if (product.showcase_post_id) {
            const thread = await forumChannel.threads.fetch(product.showcase_post_id).catch(() => null);
            if (thread) { 
                const msgs = await thread.messages.fetch({ limit: 1 }); 
                if (msgs.first()) { 
                    await msgs.first().edit({ embeds: [embed], components: [row] }); 
                    return; 
                } 
            }
        }

        const thread = await forumChannel.threads.create({ 
            name: `${product.id} - ${product.store.toUpperCase()}`, 
            message: { embeds: [embed], components: [row] }, 
            autoArchiveDuration: 10080 
        });
        await pool.query(`UPDATE products SET showcase_post_id = $1 WHERE id = $2`, [thread.id, product.id]);
    } catch (err) { 
        console.error("Error syncing showcase: ", err.message); 
    }
}

async function ensureLogChannel(userId, username, store) {
    try {
        const customerRes = await pool.query(`SELECT log_key_${store} as log_key FROM customers WHERE user_id = $1`, [userId]);
        if (customerRes.rows.length > 0 && customerRes.rows[0].log_key) {
            const guild = client.guilds.cache.get(LOG_CONFIG.guildId);
            if (!guild) return null;
            const channelId = customerRes.rows[0].log_key.split('_')[0];
            let channel = guild.channels.cache.get(channelId);
            if (!channel) channel = await createNewLogChannel(userId, username, store);
            else if (channel.parentId !== LOG_CONFIG.activeCategoryId) await channel.setParent(LOG_CONFIG.activeCategoryId);
            
            await pool.query(`UPDATE customers SET last_log_activity = NOW() WHERE user_id = $1`, [userId]);
            return { channelId: channel.id };
        }
        const channel = await createNewLogChannel(userId, username, store);
        return { channelId: channel.id };
    } catch (err) { 
        return null; 
    }
}

async function createNewLogChannel(userId, username, store) {
    const guild = client.guilds.cache.get(LOG_CONFIG.guildId);
    if (!guild) throw new Error("Log guild not found");
    
    const prefix = LOG_CONFIG.storePrefixes[store] || "0-UNK ";
    const cleanUsername = username.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 20);
    
    const channel = await guild.channels.create({
        name: `${prefix}| ${cleanUsername}`.substring(0, 100),
        type: 0,
        parent: LOG_CONFIG.activeCategoryId,
        permissionOverwrites: [
            { id: guild.roles.everyone, deny: ['ViewChannel'] },
            { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ManageWebhooks', 'EmbedLinks'] }
        ]
    });
    await channel.createWebhook({ name: 'Milo Log System', avatar: client.user.displayAvatarURL() });
    await pool.query(`UPDATE customers SET log_key_${store} = $1, last_log_activity = NOW() WHERE user_id = $2`, [`${channel.id}_${username}_${store}`, userId]);
    return channel;
}

async function getChannelWebhookUrl(channelId) {
    try {
        const channel = client.guilds.cache.get(LOG_CONFIG.guildId)?.channels.cache.get(channelId);
        if (!channel) return null;
        const webhooks = await channel.fetchWebhooks();
        return webhooks.find(w => w.name === 'Milo Log System')?.url || null;
    } catch (err) {
        return null;
    }
}

async function mirrorToLog(userId, content, type = 'text', extraData = {}) {
    try {
        const session = clientSession[userId];
        const store = session?.product?.store || session?.selected_store || extraData.store || 'occult';
        
        let logKey = null;
        const res = await pool.query(`SELECT log_key_${store}, log_key_occult, log_key_side, log_key_occult_x_side FROM customers WHERE user_id = $1`, [userId]);
        if (res.rows.length) {
            logKey = res.rows[0][`log_key_${store}`] || res.rows[0].log_key_occult || res.rows[0].log_key_side || res.rows[0].log_key_occult_x_side;
        }
        if (!logKey) return;

        const webhookUrl = await getChannelWebhookUrl(logKey.split('_')[0]);
        if (!webhookUrl) return;

        const timestamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        let payload = {};

        if (type === 'delivery') {
            payload = { 
                username: 'Milo Bot', 
                embeds: [ 
                    { 
                        title: '📦 DELIVERY CONFIRMED', 
                        color: 0x2ecc71, 
                        fields: [
                            { name: 'Customer', value: `<@${userId}>`, inline: true }, 
                            { name: 'Product', value: extraData.productId || 'N/A', inline: true }, 
                            { name: 'Store', value: extraData.store || store.toUpperCase(), inline: true }, 
                            { name: 'Tier', value: extraData.tier || 'Basic', inline: true }, 
                            { name: 'Status', value: 'Delivered & Archived', inline: true }, 
                            { name: 'Download Link', value: `[Click to View File](${extraData.downloadUrl || '#'})`, inline: false }
                        ], 
                        timestamp: new Date().toISOString() 
                    }
                ] 
            };
        } else {
            payload = { 
                username: type === 'bot' ? 'Milo Bot' : `${extraData.username || 'Client'}`, 
                content: `[${timestamp}] ${content}`, 
                allowed_mentions: { parse: [] } 
            };
        }

        await fetch(webhookUrl, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload) 
        });
        
        await pool.query(`UPDATE customers SET last_log_activity = NOW() WHERE user_id = $1`, [userId]);
    } catch (err) { 
        console.error("Mirror Log Error:", err); 
    }
}

const queueChannelCache = new Map();
async function ensureProductQueueChannel(productId, store) {
    try {
        const guild = client.guilds.cache.get(LOG_CONFIG.guildId);
        if (!guild) return null;

        const cacheKey = `${store}_${productId}`;
        if (queueChannelCache.has(cacheKey)) { 
            const existing = guild.channels.cache.get(queueChannelCache.get(cacheKey).id); 
            if (existing) return existing; 
            queueChannelCache.delete(cacheKey); 
        }

        let category = guild.channels.cache.find(c => c.name === store.toUpperCase() && c.type === 4);
        if (!category) category = await guild.channels.create({ 
            name: store.toUpperCase(), 
            type: 4, 
            permissionOverwrites: [
                { id: guild.roles.everyone, deny: ['ViewChannel'] }, 
                { id: client.user.id, allow: ['ViewChannel', 'ManageChannels', 'SendMessages', 'EmbedLinks'] }
            ] 
        });

        const channelName = `fila-${productId.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-')}`;
        let queueChannel = guild.channels.cache.find(c => c.name === channelName && c.parentId === category.id && c.type === 0);
        
        if (!queueChannel) {
            queueChannel = await guild.channels.create({ 
                name: channelName, 
                type: 0, 
                parent: category.id, 
                topic: `Exclusive queue for ${productId} | Store: ${store}`, 
                permissionOverwrites: [
                    { id: guild.roles.everyone, deny: ['ViewChannel'] }, 
                    { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'EmbedLinks'] }
                ] 
            });
            await queueChannel.send({ 
                embeds: [new EmbedBuilder().setTitle(`Queue history started: ${productId}`).setDescription(`This channel will monitor all queue events for this product.`).setColor(0x2ecc71).setTimestamp()] 
            });
        }
        
        queueChannelCache.set(cacheKey, queueChannel);
        return queueChannel;
    } catch (err) { 
        return null; 
    }
}

async function sendQueueLog(type, data) {
    try {
        const channel = await ensureProductQueueChannel(data.productId, data.store);
        if (!channel) return;

        const colors = { entry: 0x2ecc71, optin: 0xf1c40f, expired_optin: 0xe67e22, promoted: 0x2ecc71, inactivity: 0xe74c3c, sold: 0x2ecc71, reset: 0x3498db, error: 0x95a5a6 };
        const icons = { entry: "🟢", optin: "🔔", expired_optin: "⏰", promoted: "🚀", inactivity: "⚠️", sold: "✅", reset: "🔄", error: "❌" };
        const titles = { entry: "NEW QUEUE ENTRY", optin: "OPT-IN CONFIRMED", expired_optin: "OPT-IN TIMEOUT", promoted: "PROMOTED TO #1", inactivity: "#1 INACTIVITY TIMEOUT", sold: "PRODUCT SOLD OUT", reset: "QUEUE RESET BY ADMIN", error: "QUEUE SYSTEM ERROR" };

        const embed = new EmbedBuilder()
            .setTitle(`${icons[type] || "❓"} ${titles[type] || type.toUpperCase()}`)
            .setColor(colors[type] || 0x95a5a6)
            .setTimestamp()
            .setFooter({ text: `Store: ${data.store?.toUpperCase() || 'N/A'}` });

        if (type === 'entry') embed.addFields({ name: "User", value: `<@${data.userId}>`, inline: true }, { name: "Position", value: `#${data.position}`, inline: true }, { name: "Est. Wait", value: `~${data.waitTime} min`, inline: true });
        else if (type === 'optin') embed.addFields({ name: "User", value: `<@${data.userId}>`, inline: true }, { name: "Status", value: "Will receive updates", inline: true });
        else if (type === 'promoted') embed.addFields({ name: "New #1", value: `<@${data.userId}>`, inline: true }, { name: "Previous #1", value: data.previousUser ? `<@${data.previousUser}>` : 'None', inline: true }, { name: "Time Left", value: `${data.timeLeft} min`, inline: true });
        else if (type === 'inactivity') embed.addFields({ name: "Lost Spot", value: `<@${data.userId}>`, inline: true }, { name: "Next in Line", value: data.nextUser ? `<@${data.nextUser}>` : 'None', inline: true }, { name: "Reason", value: "No payment method in 3 min", inline: true });
        else if (type === 'sold') embed.addFields({ name: "Buyer", value: `<@${data.buyerId}>`, inline: true }, { name: "Method", value: data.paymentMethod || 'N/A', inline: true }, { name: "Queue Cleared", value: `${data.usersRemoved} users notified`, inline: true });
        else if (type === 'reset') embed.addFields({ name: "Admin", value: `<@${data.adminId}>`, inline: true }, { name: "Users Removed", value: `${data.usersRemoved}`, inline: true });

        await channel.send({ embeds: [embed] });
    } catch (err) {}
}

setInterval(async () => {
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const res = await pool.query(`SELECT user_id, log_key_occult, log_key_side, log_key_occult_x_side FROM customers WHERE (log_key_occult IS NOT NULL OR log_key_side IS NOT NULL OR log_key_occult_x_side IS NOT NULL) AND last_log_activity < $1`, [sevenDaysAgo]);
        const guild = client.guilds.cache.get(LOG_CONFIG.guildId);
        if (!guild) return;

        for (const row of res.rows) {
            for (const key of [row.log_key_occult, row.log_key_side, row.log_key_occult_x_side].filter(Boolean)) {
                const channel = guild.channels.cache.get(key.split('_')[0]);
                if (channel && channel.parentId !== LOG_CONFIG.archiveCategoryId) { 
                    await channel.setParent(LOG_CONFIG.archiveCategoryId); 
                    await channel.setName(channel.name.replace(' ', '')); 
                }
            }
        }
    } catch (err) {}
}, 6 * 60 * 60 * 1000);

function getTierBar(purchaseDates) {
    const now = Date.now(), thirtyDaysMs = 30 * 24 * 60 * 60 * 1000, fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    let filledBlocks = 0, earliestExpiry = Infinity;
    
    purchaseDates.forEach(date => {
        const age = now - new Date(date).getTime();
        if (age < thirtyDaysMs) {
            filledBlocks += 5;
            if (age > thirtyDaysMs - fiveDaysMs) {
                filledBlocks -= (5 - (thirtyDaysMs - age) / (24 * 60 * 60 * 1000));
                if (age < earliestExpiry) earliestExpiry = age;
            }
        }
    });
    
    const totalBlocks = Math.min(20, Math.max(0, Math.round(filledBlocks)));
    return { bar: '█'.repeat(totalBlocks) + '░'.repeat(20 - totalBlocks), percentage: Math.round((totalBlocks / 20) * 100), earliestExpiry };
}

async function ensureCustomer(userId) {
    const res = await pool.query(`SELECT * FROM customers WHERE user_id = $1`, [userId]);
    if (res.rows.length === 0) {
        await pool.query(`INSERT INTO customers (user_id, tier, purchase_dates, first_premium_notified) VALUES ($1, 'basic', '{}', FALSE)`, [userId]);
        return { user_id: userId, tier: 'basic', purchase_dates: [], first_premium_notified: false };
    }
    return res.rows[0];
}

async function checkAndUpdateTier(userId) {
    const customer = await ensureCustomer(userId);
    const recentPurchases = (customer.purchase_dates || []).filter(d => new Date(d) >= new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    
    let newTier = recentPurchases.length >= 4 ? 'premium' : 'basic';
    const oldTier = customer.tier;

    if (oldTier === 'basic' && newTier === 'premium') {
        await pool.query(`UPDATE customers SET tier = $1 WHERE user_id = $2`, ['premium', userId]);
        customer.tier = 'premium';
        
        if (!customer.first_premium_notified) {
            try { 
                const coupon = await stripeClients.occult.coupons.create({ percent_off: 3, duration: 'once', name: `Premium - ${userId}`, max_redemptions: 1, redeem_by: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 }); 
                await pool.query(`UPDATE customers SET stripe_coupon_id = $1, first_premium_notified = TRUE WHERE user_id = $2`, [coupon.id, userId]); 
            } catch (e) {}
        }
        return { customer, oldTier, newTier: 'premium', tierChanged: true, recentPurchasesCount: recentPurchases.length };
    }
    
    if (oldTier === 'premium') return { customer, oldTier, newTier: 'premium', tierChanged: false, recentPurchasesCount: recentPurchases.length };
    
    return { customer, oldTier, newTier: 'basic', tierChanged: false, recentPurchasesCount: recentPurchases.length };
}

async function registerPurchase(userId) {
    await ensureCustomer(userId);
    await pool.query(`UPDATE customers SET purchase_dates = array_append(purchase_dates, NOW()) WHERE user_id = $1`, [userId]);
}

async function registerInteraction(userId, productId, store) {
    try {
        await pool.query(`INSERT INTO product_interactions (user_id, product_id, store, interacted_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT ON CONSTRAINT unique_interaction DO UPDATE SET interacted_at = NOW()`, [userId, productId, store]);
    }
    catch (err) {
        try {
            await pool.query(`INSERT INTO product_interactions (user_id, product_id, store, interacted_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, product_id) DO UPDATE SET interacted_at = NOW()`, [userId, productId, store]);
        } catch (e2) {}
    }
}

async function notifyFullQueue(productId, store) {
    try {
        // Pega todos da fila ordenados por entrada
        const queueUsers = await pool.query(
            `SELECT user_id FROM queue_notifications WHERE product_id = $1 ORDER BY joined_at ASC`, 
            [productId]
        );
        
        for (const row of queueUsers.rows) {
            try {
                // Usa a Stored Procedure do banco para garantir cálculo correto de tempo e posição
                const info = await pool.query(`SELECT * FROM get_user_queue_info($1, $2)`, [row.user_id, productId]);
                
                if (info.rows.length === 0) continue;
                
                const user = await client.users.fetch(row.user_id);
                const rowData = info.rows[0];
                
                // Mensagem baseada no retorno seguro do banco
                const msg = rowData.is_first && rowData.posicao === 1 
                    ? `**You are #1 in the queue!**\nThe product is reserved exclusively for you for approximately **${rowData.wait_time_minutes} minutes**.` 
                    : `**Queue Position: #${rowData.posicao}**\nEstimated wait time: ~**${rowData.wait_time_minutes} minutes**.`;
                    
                await (await user.createDM()).send({ content: msg });
            } catch (e) { console.error("Erro ao notificar fila:", e); }
        }
    } catch (err) { console.error("Erro crítico na notificação da fila:", err); }
}
async function clearQueueAndNotifyBought(productId, store) {
    try {
        const queueRes = await pool.query(`SELECT user_id FROM queue_notifications WHERE product_id = $1`, [productId]);
        await pool.query(`DELETE FROM queue_notifications WHERE product_id = $1`, [productId]);
        
        for (const row of queueRes.rows) {
            try {
                await (await (await client.users.fetch(row.user_id)).createDM()).send({
                    content: `**🚫Product Sold Out**\nThe product you were waiting for has been purchased by another customer.`,
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Browse Other Products").setStyle(ButtonStyle.Secondary))]
                });
            } catch(e){}
        }
    } catch (err) {}
}

async function resetQueueManually(productId, store) {
    try {
        const queueRes = await pool.query(`SELECT user_id FROM queue_notifications WHERE product_id = $1`, [productId]);
        await pool.query(`DELETE FROM queue_notifications WHERE product_id = $1`, [productId]);
        await pool.query(`UPDATE product_reservations SET status = 'EXPIRED' WHERE product_id = $1 AND status IN ('ACTIVE', 'SITE_RESERVATION')`, [productId]);
        
        for (const row of queueRes.rows) {
            try {
                await (await (await client.users.fetch(row.user_id)).createDM()).send({
                    content: `🔄 **Queue Reset**\nThe queue has been reset by store owners. Please try again later if you are still interested.`,
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))]
                });
            } catch(e){}
        }
    } catch (err) {}
}

async function getActiveQueueCount(productId) {
    try {
        return parseInt((await pool.query(`SELECT COUNT(*) as count FROM product_reservations WHERE product_id = $1 AND status IN ('ACTIVE', 'SITE_RESERVATION') AND expires_at > NOW()`, [productId])).rows[0].count);
    } catch(e) {
        return 0;
    }
}

async function checkAndReserveProduct(userId, productId, store, durationMinutes = 10) {
    // Usa uma conexão dedicada para garantir isolamento total nesta operação crítica
    const dbClient = await pool.connect();
    try {
        // Nível SERIALIZABLE é obrigatório para evitar que duas transações leiam "vazio" simultaneamente
        await dbClient.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        await dbClient.query('BEGIN');

        // 1. Limpa expirados DENTRO da transação para não contar reservas mortas
        await dbClient.query(
            `UPDATE product_reservations SET status = 'EXPIRED' 
             WHERE product_id = $1 AND status IN ('ACTIVE', 'SITE_RESERVATION') AND expires_at < NOW()`,
            [productId]
        );

        // 2. TRAVA A LINHA DO PRODUTO SE EXISTIR RESERVA ATIVA
        // O FOR UPDATE sem SKIP LOCKED faz com que a segunda pessoa fique esperando 
        // a primeira terminar a transação antes de conseguir ler o estado real.
        const activeCheck = await dbClient.query(
            `SELECT id FROM product_reservations 
             WHERE product_id = $1 AND status IN ('ACTIVE', 'SITE_RESERVATION') AND expires_at > NOW() 
             LIMIT 1 FOR UPDATE`, 
            [productId]
        );

        if (activeCheck.rows.length > 0) {
            // Já tem dono. Rola pra trás e avisa.
            await dbClient.query('ROLLBACK');
            return { success: false, message: "Product is currently reserved." };
        }

        // 3. Se chegou aqui, é GARANTIDO que ninguém tem a reserva neste exato momento.
        // Cria a reserva imediatamente dentro da mesma transação travada.
        await dbClient.query(
            `INSERT INTO product_reservations (user_id, product_id, store, expires_at, status)
             VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::INTERVAL, 'ACTIVE')`,
            [userId, productId, store, durationMinutes]
        );

        await dbClient.query('COMMIT');

        // Busca o expires_at real criado pelo banco para retornar precisão absoluta
        const newRes = await pool.query(
            `SELECT expires_at FROM product_reservations 
             WHERE user_id = $1 AND product_id = $2 AND status = 'ACTIVE' 
             ORDER BY reserved_at DESC LIMIT 1`,
            [userId, productId]
        );

        return {
            success: true,
            expiresAt: newRes.rows[0]?.expires_at
        };

    } catch (err) {
        await dbClient.query('ROLLBACK');
        
        // Erro 40001 é "Serialization Failure". Significa que outra pessoa ganhou a corrida.
        // Tratamos como "Produto Reservado" para segurança máxima.
        if (err.code === '40001') {
            console.log(`[RACE CONDITION BLOCKED] User ${userId} tried to grab #1 for ${productId} but failed.`);
            return { success: false, message: "Product is currently reserved." };
        }
        
        console.error("Reservation error:", err);
        return { success: false, message: "System error during reservation." };
    } finally {
        dbClient.release();
    }
}

async function notifyNextInQueue(productId, store) {
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        
        // 1. Limpa reservas expiradas dentro da transação
        await dbClient.query(
            `UPDATE product_reservations SET status = 'EXPIRED' 
             WHERE product_id = $1 AND status IN ('ACTIVE', 'SITE_RESERVATION') AND expires_at < NOW()`, 
            [productId]
        );
        
        // 2. Pega o próximo da fila COM LOCK
        const nextUserRes = await dbClient.query(
            `SELECT user_id FROM queue_notifications 
             WHERE product_id = $1 AND notified = FALSE 
             ORDER BY joined_at ASC 
             LIMIT 1 FOR UPDATE SKIP LOCKED`, 
            [productId]
        );
        
        if (nextUserRes.rows.length === 0) {
            await dbClient.query('ROLLBACK');
            return;
        }
        
        const userId = nextUserRes.rows[0].user_id;
        
        // 3. Cria a reserva de 10 min IMEDIATAMENTE
        await dbClient.query(
            `INSERT INTO product_reservations (user_id, product_id, store, expires_at, status) 
             VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', 'ACTIVE')`, 
            [userId, productId, store]
        );
        
        // 4. Remove da fila e marca como notificado
        await dbClient.query(`DELETE FROM queue_notifications WHERE user_id = $1 AND product_id = $2`, [userId, productId]);
        await dbClient.query(`UPDATE queue_notifications SET notified = TRUE WHERE user_id = $1 AND product_id = $2`, [userId, productId]);
        
        await dbClient.query('COMMIT');
        
       // 5. Cria a sessão enquanto o usuário ainda está na etapa
// "Product Released".
// Os 10 minutos da reserva já começaram no banco.
clientSession[userId] = {
    step: "waiting_for_payment_method",
    product: {
        id: productId,
        store
    },
    lastActivity: Date.now()
};

// Inicia a tolerância de 3 minutos para clicar em Complete Payment.
startPaymentSelectionTimer(userId, productId, store);
        
        // 6. Envia DM com TEMPO CORRETO (Sem erro de 3h)
        try {
            const user = await client.users.fetch(userId); 
            const dm = await user.createDM();
            
           // Busca quantos segundos realmente faltam para a reserva expirar.
// O PostgreSQL calcula isso diretamente, evitando qualquer problema de fuso horário.
const resInfo = await pool.query(
    `SELECT GREATEST(
        0,
        EXTRACT(EPOCH FROM (expires_at - NOW()))
    )::INT AS seconds_left
     FROM product_reservations
     WHERE user_id = $1
       AND product_id = $2
       AND status = 'ACTIVE'
     LIMIT 1`,
    [userId, productId]
);

// Converte o tempo restante real para um timestamp Unix do Discord.
const secondsLeft = resInfo.rows[0]?.seconds_left ?? 600;
const expiresTs = Math.floor(Date.now() / 1000) + secondsLeft;
            
            await dm.send({
                content: `**Product Released!**\nThe previous reservation expired. **${productId}** is now reserved exclusively for you!\n⏰ You have until <t:${expiresTs}:R> to complete payment.\nClick below to proceed:`,
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`queue_claim_${productId.replace(/ /g, '_')}`).setLabel(" Complete Payment").setStyle(ButtonStyle.Success)
                )]
            });
        } catch (e) { console.error("Erro ao enviar DM de liberação:", e); }
        
        // 7. Loga a promoção
        await sendQueueLog('promoted', { 
            userId, productId, store, timeLeft: 10 
        });
        
    } catch (err) {
        await dbClient.query('ROLLBACK');
        console.error("Erro crítico em notifyNextInQueue:", err);
    } finally {
        dbClient.release();
    }
}

// ====================== FUNÇÕES DE CRÉDITO E SUPORTE ======================
async function getCreditBalance(userId, store) {
    try {
        const res = await pool.query(`SELECT balance FROM customer_credits WHERE user_id = $1 AND store = $2`, [userId, store]);
        return res.rows.length > 0 ? parseFloat(res.rows[0].balance) : 0;
    } catch (err) {
        return 0;
    }
}

async function getRefundCreditBalance(userId, store) {
    try {
        const res = await pool.query(`SELECT refund_credit_balance FROM customer_credits WHERE user_id = $1 AND store = $2`, [userId, store]);
        return res.rows.length > 0 ? parseFloat(res.rows[0].refund_credit_balance) : 0;
    } catch (err) {
        return 0;
    }
}

async function addCreditBalance(userId, store, amount, isRefundCredit = false) {
    try {
        if (isRefundCredit) await pool.query(`INSERT INTO customer_credits (user_id, store, balance, refund_credit_balance, updated_at) VALUES ($1, $2, $3, $3, NOW()) ON CONFLICT (user_id, store) DO UPDATE SET balance = customer_credits.balance + $3, refund_credit_balance = customer_credits.refund_credit_balance + $3, updated_at = NOW()`, [userId, store, amount]);
        else await pool.query(`INSERT INTO customer_credits (user_id, store, balance, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, store) DO UPDATE SET balance = customer_credits.balance + $3, updated_at = NOW()`, [userId, store, amount]);
    } catch (err) {}
}

async function deductCreditBalance(userId, store, amount) {
    try {
        const current = await getCreditBalance(userId, store);
        if (current >= amount) {
            const currentRefundBalance = await getRefundCreditBalance(userId, store);
            let remainingRefundBalance = currentRefundBalance;
            
            if (currentRefundBalance > 0) {
                if (amount <= currentRefundBalance) remainingRefundBalance -= amount;
                else remainingRefundBalance = 0;
                
                const spentFromRefund = Math.min(amount, currentRefundBalance);
                const tickets = await pool.query(`SELECT id, reason FROM support_tickets WHERE user_id = $1 AND store = $2 AND status = 'APPROVED' AND method = 'credit' ORDER BY created_at ASC`, [userId, store]);
                
                let amountToConsume = spentFromRefund;
                for (const ticket of tickets.rows) {
                    if (amountToConsume <= 0) break;
                    const match = ticket.reason.match(/\$(\d+(\.\d+)?)/);
                    let ticketValue = match ? parseFloat(match[1]) : 0;
                    
                    if (ticketValue > 0) { 
                        if (amountToConsume >= ticketValue) { 
                            await pool.query(`UPDATE support_tickets SET status = 'CONSUMED' WHERE id = $1`, [ticket.id]); 
                            amountToConsume -= ticketValue; 
                        } else break; 
                    }
                }
            }
            
            await pool.query(`UPDATE customer_credits SET balance = balance - $1, refund_credit_balance = $2, updated_at = NOW() WHERE user_id = $3 AND store = $4`, [amount, remainingRefundBalance, userId, store]);
            return true;
        }
        return false;
    } catch (err) { 
        return false; 
    }
}

async function getUserPurchaseHistory(userId, store) {
    try {
        const salesRes = await pool.query(`SELECT p.id, p.price, s.created_at FROM partnership_approvals s JOIN products p ON s.product_id = p.id WHERE s.user_id = $1 AND p.store = $2 AND s.status = 'APPROVED' ORDER BY s.created_at DESC LIMIT 10`, [userId, store]);
        return salesRes.rows.map(row => ({ id: row.id, price: typeof row.price === 'string' ? JSON.parse(row.price) : {}, date: row.created_at ? new Date(row.created_at).toLocaleDateString('en-US') : 'Unknown' }));
    } catch (err) {
        return [];
    }
}

async function getRecentInteractions(userId, store) {
    try {
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
        const res = await pool.query(`SELECT DISTINCT ON (pi.product_id) pi.product_id, p.price, pi.interacted_at FROM product_interactions pi JOIN products p ON pi.product_id = p.id WHERE pi.user_id = $1 AND pi.store = $2 AND pi.interacted_at >= $3 ORDER BY pi.product_id, pi.interacted_at DESC`, [userId, store, twoDaysAgo]);
        return res.rows.map(row => ({ id: row.product_id, price: typeof row.price === 'string' ? JSON.parse(row.price) : {} }));
    } catch (err) {
        return [];
    }
}

// ====================== FUNÇÕES AUXILIARES PAINÉIS ======================
async function reopenAdminPanel(source, wizard) {
    if (!wizard || !wizard.targetUserId || !wizard.store) return;
    
    const targetUser = await client.users.fetch(wizard.targetUserId).catch(() => null);
    if (!targetUser) return;

    const tierData = await checkAndUpdateTier(wizard.targetUserId);
    const balance = await getCreditBalance(wizard.targetUserId, wizard.store);
    const history = await getUserPurchaseHistory(wizard.targetUserId, wizard.store);
    const lastPurchase = history.length > 0 ? `${history[0].id} ($${typeof history[0].price === 'object' ? parseFloat(history[0].price.basic_stripe.replace('$', '')) : history[0].price}) - ${history[0].date}` : "None";
    
    const barInfo = getTierBar(tierData.customer.purchase_dates || []);
    
    const embed = new EmbedBuilder()
        .setTitle(`MANAGEMENT PANEL: ${targetUser.username}`)
        .setDescription(`ID: ${targetUser.id} | Store: ${wizard.store.toUpperCase()}\n──────────────────────`)
        .addFields(
            { name: "⭐ Current Tier", value: tierData.newTier === 'premium' ? '💎 Premium' : '🌟 Basic', inline: true }, 
            { name: "Progress", value: `${barInfo.bar} ${barInfo.percentage}%`, inline: true }, 
            { name: "💰 Wallet", value: `$${balance.toFixed(2)} (${wizard.store.toUpperCase()})`, inline: true }, 
            { name: "📊 Statistics", value: `${history.length} Purchases | Last: ${lastPurchase}`, inline: false }
        ).setColor(0x3498db);

    const components = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("admin_action_credits").setLabel("💳 Manage Credits").setStyle(ButtonStyle.Primary), 
            new ButtonBuilder().setCustomId("admin_action_tier").setLabel("⭐ Change Tier").setStyle(ButtonStyle.Secondary), 
            new ButtonBuilder().setCustomId("admin_action_history").setLabel("📜 View History").setStyle(ButtonStyle.Secondary)
        ), 
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("admin_action_reset_queue").setLabel("🔄 Reset Queue").setStyle(ButtonStyle.Danger), 
            new ButtonBuilder().setCustomId("admin_action_ban").setLabel("🚫 Block/Unblock").setStyle(ButtonStyle.Danger)
        )
    ];

    if (source.followUp) await source.followUp({ embeds: [embed], components, ephemeral: true }); 
    else if (source.editReply) await source.editReply({ embeds: [embed], components }); 
    else if (source.channel) await source.channel.send({ embeds: [embed], components });
}

async function reopenEditMenu(source, wizard, prodId) {
    const product = (await pool.query(`SELECT * FROM products WHERE id = $1 AND store = $2`, [prodId, wizard.store])).rows[0];
    if (!product) return;
    
    wizard.step = "editing_product"; 
    wizard.productId = prodId; 
    wizard.productData = product;

    const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price;
    const embed = new EmbedBuilder()
        .setTitle(`✏️ Editando: ${prodId}`)
        .setDescription(`Loja: **${wizard.store.toUpperCase()}**\nArquivado: ${product.archived ? 'Sim' : 'Não'}`)
        .addFields(
            { name: "💳 Stripe Basic", value: prices.basic_stripe || 'N/A', inline: true }, 
            { name: "💎 Lindens Basic", value: prices.basic_lindens || 'N/A', inline: true }, 
            { name: "📥 Download", value: product.file_download ? `[Link](${product.file_download})` : 'N/A', inline: false }
        ).setColor(0xf39c12);

    const components = [
        new ActionRowBuilder().addComponents(
            // --- NOVO BOTÃO ADICIONADO AQUI ---
            new ButtonBuilder()
                .setCustomId(`edit_action_portfolio_${prodId.replace(/ /g, '_')}`)
                .setLabel("🖼️ Enviar p/ Portfólio")
                .setStyle(ButtonStyle.Primary), 
            // ----------------------------------
            new ButtonBuilder().setCustomId(`edit_action_price_${prodId.replace(/ /g, '_')}`).setLabel("💰 Alterar Preço").setStyle(ButtonStyle.Primary), 
            new ButtonBuilder().setCustomId(`edit_action_image_${prodId.replace(/ /g, '_')}`).setLabel("🖼️ Alterar Imagem").setStyle(ButtonStyle.Secondary), 
            new ButtonBuilder().setCustomId(`edit_action_download_${prodId.replace(/ /g, '_')}`).setLabel("📥 Alterar Download").setStyle(ButtonStyle.Secondary)
        ), 
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`edit_action_archive_${prodId.replace(/ /g, '_')}`).setLabel(product.archived ? "📦 Desarquivar" : "🗄️ Arquivar").setStyle(ButtonStyle.Danger), 
            new ButtonBuilder().setCustomId(`edit_action_delete_${prodId.replace(/ /g, '_')}`).setLabel("🗑️ Excluir Produto").setStyle(ButtonStyle.Danger)
        ), 
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("edit_back_to_list").setLabel("🔙 Ver Outros Produtos").setStyle(ButtonStyle.Secondary)
        )
    ];

    if (source.followUp) await source.followUp({ embeds: [embed], components, ephemeral: true }); 
    else if (source.channel) await source.channel.send({ embeds: [embed], components });
}

// ====================== FUNÇÃO DE RESERVA DE CHECKOUT ======================
async function reserveProductForCheckout(productId, store) {
    try {
        // NOTA: NÃO marcamos archived = TRUE aqui. 
        // O produto continua na vitrine até a aprovação final do lojista.
        
        // Apenas atualizamos a Planilha para indicar que está em análise
        const jwtClient = await getJwtClient();
        const fullRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A:R`, { 
            headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}` } 
        });
        const fullData = await fullRes.json();
        const rows = fullData.values || [];
        
        let rowIndex = -1;
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] && rows[i][0].toString().trim() === productId.toString().trim()) {
                const status = rows[i][4] ? rows[i][4].toString().trim() : '';
                if (status.includes('Disponível') || status.includes('🟢')) {
                    rowIndex = i + 1;
                    break;
                }
            }
        }

        if (rowIndex !== -1) {
            await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!E${rowIndex}`, { 
                method: 'PUT', 
                headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}`, 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ values: [['⏳ Em Análise']] }) 
            });
        }
    } catch (e) { 
        console.error("Erro ao reservar produto para checkout:", e); 
    }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });
const ADMIN_ROLE_ID = "1511825776520200272";
const STORE_OWNERS = {
    occult: [ID_MICSCARR, ID_OCCULTSIDE_OFFICIAL],
    side: [ID_POLYPIE, ID_OCCULTSIDE_OFFICIAL],
    occult_x_side: [ID_MICSCARR, ID_POLYPIE, ID_OCCULTSIDE_OFFICIAL]
};
const SUPPORT_DMS = {
    occult: [ID_MICSCARR, ID_OCCULTSIDE_OFFICIAL],
    side: [ID_POLYPIE, ID_OCCULTSIDE_OFFICIAL],
    occult_x_side: [ID_MICSCARR, ID_POLYPIE, ID_OCCULTSIDE_OFFICIAL]
};
const MAX_RECEIPT_ATTEMPTS = 2;
const adminWizard = {}, clientSession = {}, pendingApprovals = {};

client.once(Events.ClientReady, async () => {
    console.log(`Milo online as ${client.user.tag}`);
    const logGuild = client.guilds.cache.get(LOG_CONFIG.guildId);
    if (logGuild) console.log(`Connected to Log Server: ${logGuild.name}`);
});

function resetSessionTimer(userId) {
    if (clientSession[userId]?.timeoutId) clearTimeout(clientSession[userId].timeoutId);
    if (clientSession[userId]) {
        clientSession[userId].lastActivity = Date.now();
        clientSession[userId].timeoutId = setTimeout(() => { delete clientSession[userId]; }, SESSION_TIMEOUT);
    }
}

function startPaymentSelectionTimer(userId, productId, store) {
    if (clientSession[userId]?.paymentTimeoutId) {
        clearTimeout(clientSession[userId].paymentTimeoutId);
    }

    if (!clientSession[userId]) {
        clientSession[userId] = {
            step: "waiting_for_payment_method",
            product: { id: productId, store },
            lastActivity: Date.now()
        };
    }

    clientSession[userId].paymentTimeoutId = setTimeout(async () => {
        const session = clientSession[userId];

        // Só expulsa se a pessoa ainda NÃO clicou em Complete Payment.
        if (session?.step === "waiting_for_payment_method") {
            await cancelReservationDueToInactivity(
                userId,
                productId,
                store,
                "timeout"
            );

            delete clientSession[userId];
        }
    }, PAYMENT_SELECTION_TIMEOUT);
}
// ====================== FUNÇÃO DE CANCELAMENTO POR INATIVIDADE ======================
async function cancelReservationDueToInactivity(userId, productId, store, reason = "timeout") {
    try {
        // Cancela qualquer timer de 3 minutos que ainda esteja ativo
        if (clientSession[userId]?.paymentTimeoutId) {
            clearTimeout(clientSession[userId].paymentTimeoutId);
            delete clientSession[userId].paymentTimeoutId;
        }

        // Expira a reserva atual
        const expiredRes = await pool.query(
            `UPDATE product_reservations
             SET status = 'EXPIRED'
             WHERE user_id = $1
               AND product_id = $2
               AND status IN ('ACTIVE', 'SITE_RESERVATION')
             RETURNING *`,
            [userId, productId]
        );

        // Se não havia reserva ativa, não continua
        if (expiredRes.rows.length === 0) {
            return;
        }

        // =====================================================
        // END SESSION
        // Não manda "Reservation Expired".
        // O próprio botão já mostrará "Session ended successfully."
        // =====================================================
        if (reason === "end_session") {
            await sendQueueLog('inactivity', {
                userId,
                productId,
                store,
                reason
            });
            await notifyNextInQueue(productId, store);
            return;
        }

        // =====================================================
        // TIMEOUT DOS 3 MINUTOS
        // Aqui SIM manda Reservation Expired.
        // =====================================================
        try {
            const user = await client.users.fetch(userId);
            await user.send({
                content:
                    `⚠️ **Reservation Expired**\n\n` +
                    `Your exclusive reservation for **${productId}** has been cancelled due to inactivity. ` +
                    `The product is now available to the next person in line.`,
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId("start_new_order")
                            .setLabel("🛒 Start New Order")
                            .setStyle(ButtonStyle.Primary)
                    )
                ]
            });
        } catch (e) {
            console.error(
                "Failed to notify user of inactivity:",
                e
            );
        }

        await sendQueueLog('inactivity', {
            userId,
            productId,
            store,
            reason
        });

        // Promove o próximo
        await notifyNextInQueue(productId, store);
    } catch (err) {
        console.error(
            "Error cancelling reservation due to inactivity:",
            err
        );
    }
}
// FIM DA FUNÇÃO ADICIONADA 👆

async function sendReturnMessage(user, msg) {
    try {
        const dm = await user.createDM();
        if (msg) await dm.send({ content: msg });
        await dm.send({ components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Primary))] });
    } catch (e) {}
}

async function sendIntroDM(user, isReturning = false, tierData = null) {
    try {
        const dm = await user.createDM();
        let content = "";
        
        if (!isReturning) {
            content = `Welcome!\nOccult and Side are two separate stores.\nPlease select the store associated with the product you're interested in.\nChoose an option below:`;
        } else {
            const barInfo = getTierBar(tierData.customer.purchase_dates || []);
            const lastDate = tierData.customer.purchase_dates?.length > 0 ? new Date(tierData.customer.purchase_dates[tierData.customer.purchase_dates.length - 1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'N/A';
            const tierBadge = tierData.newTier === 'premium' ? '💎 Premium' : '🌟 Basic';
            
            if (tierData.newTier === 'premium') {
                const daysToExpire = barInfo.earliestExpiry !== Infinity ? Math.ceil((barInfo.earliestExpiry - Date.now()) / 86400000) : null;
                content = daysToExpire && daysToExpire <= 5 ? `Welcome back!\n**${tierBadge}** | ${tierData.recentPurchasesCount} purchases (30d) | Last: ${lastDate}\n${barInfo.bar} ${barInfo.percentage}% • Expires in ${daysToExpire}d!\n*Buy more to refill your bar & keep benefits!*\n\nWhere would you like to shop today?` : `👋 Welcome back!\n**${tierBadge}** | ${tierData.recentPurchasesCount} purchases (30d) | Last: ${lastDate}\n${barInfo.bar} 100% Secure\n*Benefits active & ready!*\n\nWhere would you like to shop today?`;
            } else {
                const needed = 4 - tierData.recentPurchasesCount;
                content = `👋 Welcome back!\n🌟 Basic | ${tierData.recentPurchasesCount} purchases (30d) | Last: ${lastDate}\n${barInfo.bar} ${barInfo.percentage}% to Premium\n${needed} more purchases to unlock Premium!\n\nWhere would you like to shop today?`;
            }
        }
        
        await dm.send({ 
            content, 
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("client_store_occult").setLabel("🛒 Occult").setStyle(ButtonStyle.Primary), 
                new ButtonBuilder().setCustomId("client_store_side").setLabel("🛒 Side").setStyle(ButtonStyle.Primary), 
                new ButtonBuilder().setCustomId("client_store_occult_x_side").setLabel("🛒 OccultSide").setStyle(ButtonStyle.Primary)
            )] 
        });
        
        if (isReturning) await mirrorToLog(user.id, content, 'bot', { username: user.username });
    } catch (err) {}
}

client.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;
    try {
        await new Promise(r => setTimeout(r, 2000));
        await sendIntroDM(member, true, await checkAndUpdateTier(member.user.id));
    } catch (e) {}
});

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        // ====================== ESCUDO DE MANUTENÇÃO ======================
        if (isMaintenanceMode) {
            else if (DEV_IDS.includes(interaction.user.id)) { /* Deixa passar */ }
            else {
                const maintenanceEmbed = new EmbedBuilder().setTitle("️ System Under Maintenance").setDescription("We are currently performing scheduled updates to improve your experience.\nThe bot will be back online shortly. Please try again in a few minutes.\n\nThank you for your patience!").setColor(0xff9900).setTimestamp();
                if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
                    return interaction.reply({ embeds: [maintenanceEmbed], flags: [MessageFlags.Ephemeral] }).catch(() => {});
                }
                else return interaction.reply({ embeds: [maintenanceEmbed], flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
        }

        if (clientSession[interaction.user.id]) resetSessionTimer(interaction.user.id);
        
        // CORREÇÃO 2: ESPELHAMENTO TOTAL DE BOTÕES (Antes de qualquer lógica)
        if (interaction.isButton() || interaction.isStringSelectMenu()) {
            const uid = interaction.user.id;
            const hasLog = (await pool.query(`SELECT log_key_occult, log_key_side, log_key_occult_x_side FROM customers WHERE user_id = $1`, [uid])).rows[0];
            
            if (clientSession[uid] || (hasLog && (hasLog.log_key_occult || hasLog.log_key_side || hasLog.log_key_occult_x_side))) {
                let label = interaction.customId;
                if (interaction.isButton()) label = interaction.component.label || interaction.customId;
                
                let logMsg = `Clicked button: ${label}`;
                if (interaction.customId === 'tech_info') logMsg = "Opened Technical Information";
                else if (interaction.customId === 'payment_method') logMsg = "Selected Payment Method";
                else if (interaction.customId === 'report_payment_lindens') logMsg = "Clicked Report Payment";
                else if (interaction.customId === 'end_session') logMsg = "Clicked End Session";
                else if (interaction.customId.startsWith('pay_')) logMsg = `Selected Payment: ${label}`;
                else if (interaction.customId.startsWith('support_')) logMsg = `Support Menu: ${label}`;
                else if (interaction.customId.startsWith('refund_')) logMsg = `Refund Action: ${label}`;
                
                await mirrorToLog(uid, logMsg, 'bot', { username: interaction.user.username });
            }
        }

        // ====================== COMANDO /RELATORIO ======================
        if (interaction.isChatInputCommand() && interaction.commandName === "relatorio") {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (interaction.guild.ownerId !== interaction.user.id && !member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ No permission.", flags: [MessageFlags.Ephemeral] });
            
            return interaction.reply({ 
                content: "📊 **Gerador de Relatórios**\nSelecione a loja:", 
                flags: [MessageFlags.Ephemeral], 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("report_store_occult").setLabel("🛒 Occult").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("report_store_side").setLabel("🛒 Side").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("report_store_occult_x_side").setLabel("🛒 OccultSide").setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId("report_store_all").setLabel("🌐 Todas").setStyle(ButtonStyle.Secondary)
                )] 
            });
        }

        if (interaction.isButton() && interaction.customId.startsWith("report_store_")) {
            const store = interaction.customId.replace("report_store_", "");
            adminWizard[interaction.user.id] = { type: "report", store: store };
            
            return interaction.update({ 
                content: `🏪 Loja selecionada: **${store === 'all' ? 'Todas' : store === 'occult_x_side' ? 'OccultSide' : store.toUpperCase()}**\nEscolha o período:`, 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`report_type_daily_${store}`).setLabel("📆 Diário").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`report_type_monthly_${store}`).setLabel("🗓️ Mensal").setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`report_type_yearly_${store}`).setLabel("📅 Anual").setStyle(ButtonStyle.Secondary)
                )] 
            });
        }

        if (interaction.isButton() && interaction.customId.startsWith("report_type_")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const parts = interaction.customId.split("_");
            const type = parts[2]; 
            const store = parts.slice(3).join("_");
            
            try {
                const metrics = await generateReportMetrics(store, type);
                let storeLabel = store.charAt(0).toUpperCase() + store.slice(1) + ' Store';
                if (store === 'all') storeLabel = 'Todas as Lojas';
                if (store === 'occult_x_side') storeLabel = 'OccultSide Partnership';
                
                const embed = buildReportEmbed(metrics, storeLabel);
                return interaction.editReply({ embeds: [embed] });
            } catch (err) {
                console.error("Report Error:", err);
                return interaction.editReply({ content: "❌ Erro ao gerar relatório. Verifique os logs." });
            }
        }
       // ====================== COMANDO /DEV ======================
    if (interaction.isChatInputCommand() && interaction.commandName === "dev") {
        if (!DEV_IDS.includes(interaction.user.id)) return interaction.reply({ content: "❌ Acesso negado.", flags: [MessageFlags.Ephemeral] });
        
        const embed = new EmbedBuilder()
            .setTitle("⚙️ Developer Control Panel")
            .setDescription(`System Status: 🟢 **Online** | Maintenance: ${isMaintenanceMode ? '🟡 **ON**' : '🟢 **OFF**'}\nStripe Payments: ${isStripeDisabled ? '🔴 **DISABLED**' : ' **ENABLED'**}`)
            .setColor(0x2c3e50);
            
        const components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("dev_toggle_maintenance").setLabel(`🚧 Manutenção: ${isMaintenanceMode ? 'DESATIVAR' : 'ATIVAR'}`).setStyle(isMaintenanceMode ? ButtonStyle.Success : ButtonStyle.Danger), 
            new ButtonBuilder().setCustomId("dev_toggle_stripe").setLabel(`💳 Stripe: ${isStripeDisabled ? 'ATIVAR' : 'DESATIVAR'}`).setStyle(isStripeDisabled ? ButtonStyle.Success : ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("dev_clear_session").setLabel("🧹 Limpar Sessão").setStyle(ButtonStyle.Primary), 
            new ButtonBuilder().setCustomId("dev_export_csv").setLabel("📄 Exportar CSV").setStyle(ButtonStyle.Secondary)
        )];
        return interaction.reply({ embeds: [embed], components, flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.isButton() && interaction.customId === "dev_toggle_maintenance") {
        if (!DEV_IDS.includes(interaction.user.id)) return;
        isMaintenanceMode = !isMaintenanceMode;
        
        const embed = new EmbedBuilder()
            .setTitle("⚙️ Developer Control Panel")
            .setDescription(`System Status: 🟢 **Online** | Maintenance: ${isMaintenanceMode ? '🟡 **ON**' : '🟢 **OFF**'}\nStripe Payments: ${isStripeDisabled ? '🔴 **DISABLED**' : '🟢 **ENABLED'**}`)
            .setColor(0x2c3e50);
            
        const components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("dev_toggle_maintenance").setLabel(` Manutenção: ${isMaintenanceMode ? 'DESATIVAR' : 'ATIVAR'}`).setStyle(isMaintenanceMode ? ButtonStyle.Success : ButtonStyle.Danger), 
            new ButtonBuilder().setCustomId("dev_toggle_stripe").setLabel(`💳 Stripe: ${isStripeDisabled ? 'ATIVAR' : 'DESATIVAR'}`).setStyle(isStripeDisabled ? ButtonStyle.Success : ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("dev_clear_session").setLabel("🧹 Limpar Sessão").setStyle(ButtonStyle.Primary), 
            new ButtonBuilder().setCustomId("dev_export_csv").setLabel("📄 Exportar CSV").setStyle(ButtonStyle.Secondary)
        )];
        return interaction.update({ embeds: [embed], components });
    }

    if (interaction.isButton() && interaction.customId === "dev_toggle_stripe") {
        if (!DEV_IDS.includes(interaction.user.id)) return;
        isStripeDisabled = !isStripeDisabled;
        
        const embed = new EmbedBuilder()
            .setTitle("⚙️ Developer Control Panel")
            .setDescription(`System Status: 🟢 **Online** | Maintenance: ${isMaintenanceMode ? '🟡 **ON**' : '🟢 **OFF**'}\nStripe Payments: ${isStripeDisabled ? '🔴 **DISABLED**' : ' **ENABLED'**}`)
            .setColor(0x2c3e50);
            
        const components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("dev_toggle_maintenance").setLabel(`🚧 Manutenção: ${isMaintenanceMode ? 'DESATIVAR' : 'ATIVAR'}`).setStyle(isMaintenanceMode ? ButtonStyle.Success : ButtonStyle.Danger), 
            new ButtonBuilder().setCustomId("dev_toggle_stripe").setLabel(`💳 Stripe: ${isStripeDisabled ? 'ATIVAR' : 'DESATIVAR'}`).setStyle(isStripeDisabled ? ButtonStyle.Success : ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("dev_clear_session").setLabel("🧹 Limpar Sessão").setStyle(ButtonStyle.Primary), 
            new ButtonBuilder().setCustomId("dev_export_csv").setLabel("📄 Exportar CSV").setStyle(ButtonStyle.Secondary)
        )];
        return interaction.update({ embeds: [embed], components });
    }

    if (interaction.isButton() && interaction.customId === "dev_clear_session") {
        if (!DEV_IDS.includes(interaction.user.id)) return;
        const modal = new ModalBuilder().setCustomId("dev_modal_clear_session").setTitle("Limpar Sessão de Cliente").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("target_user_id").setLabel("ID do Usuário").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && interaction.customId === "dev_modal_clear_session") {
        if (!DEV_IDS.includes(interaction.user.id)) return;
        const targetId = interaction.fields.getTextInputValue("target_user_id");
        if (clientSession[targetId]) { 
            delete clientSession[targetId]; 
            return interaction.reply({ content: `✅ Sessão do usuário \`${targetId}\` limpa com sucesso!`, flags: [MessageFlags.Ephemeral] }); 
        }
        else return interaction.reply({ content: `ℹ️ O usuário \`${targetId}\` não possui sessão ativa.`, flags: [MessageFlags.Ephemeral] });
    }
    if (interaction.isButton() && interaction.customId === "dev_export_csv") {
        if (!DEV_IDS.includes(interaction.user.id)) return;
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            const res = await pool.query(`SELECT created_at, product_id, store, user_id, payment_method, status FROM partnership_approvals WHERE created_at >= CURRENT_DATE - INTERVAL '7 days' ORDER BY created_at DESC`);
            let csvContent = "Data,ID Produto,Loja,ID Comprador,Metodo,Status\n";
            res.rows.forEach(row => { 
                const dateStr = row.created_at ? new Date(row.created_at).toLocaleString('pt-BR') : 'N/A';
                csvContent += `"${dateStr}","${row.product_id}","${row.store}","${row.user_id}","${row.payment_method}","${row.status}"\n`; 
            });
            const attachment = new AttachmentBuilder(Buffer.from(csvContent, 'utf-8'), { name: `vendas_semana_${new Date().toISOString().split('T')[0]}.csv` });
            return interaction.editReply({ content: "📄 Relatório dos últimos 7 dias gerado com sucesso!", files: [attachment] });
        } catch (err) { 
            console.error("CSV Error:", err);
            return interaction.editReply({ content: "❌ Erro ao gerar CSV. Verifique os logs." }); 
        }
    }
        // ====================== COMANDO /ADMIN-CLIENTE ======================
        if (interaction.isChatInputCommand() && interaction.commandName === "admin-cliente") {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (interaction.guild.ownerId !== interaction.user.id && !member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ No permission.", flags: [MessageFlags.Ephemeral] });
            
            adminWizard[interaction.user.id] = { type: "admin_client", step: "select_store" };
            return interaction.reply({ 
                content: "👤 **ADMIN CLIENT PANEL**\nSelect the store to manage:", 
                flags: [MessageFlags.Ephemeral], 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("admin_store_occult").setLabel("🛒 Occult").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("admin_store_side").setLabel("🛒 Side").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("admin_store_oxs").setLabel("🛒 OccultSide").setStyle(ButtonStyle.Primary)
                )] 
            });
        }

        if (interaction.isButton() && interaction.customId.startsWith("admin_store_")) {
            const w = adminWizard[interaction.user.id]; 
            if (!w || w.type !== "admin_client") return;
            w.store = interaction.customId.replace("admin_store_", "").replace("oxs", "occult_x_side"); 
            w.step = "identify_user";
            
            return interaction.update({ 
                content: `✅ **Store Selected:** ${w.store.toUpperCase()}\nPlease enter the **User ID**, **@mention**, or **Username** of the client:`, 
                components: [] 
            });
        }

        // ====================== BOTÃO BACK (TECH INFO) ======================
        if (interaction.isButton() && interaction.customId === "back_to_product") {
            await interaction.deferUpdate();
            const s = clientSession[interaction.user.id]; 
            if (!s?.product) return interaction.editReply({ content: "❌ Session expired.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            
            const isPremium = (await checkAndUpdateTier(interaction.user.id)).newTier === 'premium';
            const prices = typeof s.product.price === 'string' ? JSON.parse(s.product.price) : s.product.price;
            const priceDisplay = isPremium ? `💳 **Stripe:** ${prices.premium_stripe}\n💎 **Lindens:** ${prices.premium_lindens}` : `💳 **Stripe:** ${prices.basic_stripe}\n💎 **Lindens:** ${prices.basic_lindens}`;
            
            const embed = new EmbedBuilder().setTitle(`${s.product.id}`).setDescription(priceDisplay).setImage(s.product.image).setColor(isPremium ? 0xFFD700 : 0xffffff);
            
            return interaction.editReply({ 
                embeds: [embed], 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("tech_info").setLabel("📐 Technical Information").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("payment_method").setLabel("💳 Payment Method").setStyle(ButtonStyle.Success)
                )] 
            });
        }

        // ====================== END SESSION BUTTON FIX ======================
        if (interaction.isButton() && interaction.customId === "end_session") {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const s = clientSession[interaction.user.id];
            if (s && s.product) {
                await cancelReservationDueToInactivity(interaction.user.id, s.product.id, s.product.store, "end_session");
            }
            delete clientSession[interaction.user.id];
            
            return interaction.editReply({ 
                content: "✅ Session ended successfully.", 
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Primary))] 
            });
        }

        // ====================== CONFIRMAÇÃO DUPLA: APPROVE/DENY RECEIPT ======================
        if (interaction.isButton() && interaction.customId.startsWith("confirm_approve_receipt_")) {
            await interaction.deferUpdate();
            const targetUserId = interaction.customId.replace("confirm_approve_receipt_", "");
            const approvalData = pendingApprovals[targetUserId];
            
            if (!approvalData) return interaction.editReply({ content: "❌ Expired.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            if (approvalData.processed) return interaction.editReply({ content: `⚠️ This action has already been processed by ${approvalData.processedBy}.`, components: [] });

            try {
                const customer = await client.users.fetch(targetUserId); 
                const dm = await customer.createDM();
                const res = await pool.query(`SELECT * FROM products WHERE id = $1`, [approvalData.productId]); 
                const product = res.rows[0];
                
                const tierInfo = await checkAndUpdateTier(targetUserId); 
                const isPremium = tierInfo.newTier === 'premium';
                
                let finalMsg = `**✅ PAYMENT APPROVED!**\n\nThank you for your purchase!\n\nClick the button below to receive your product:`;
                if (isPremium) finalMsg = `**✅ PAYMENT APPROVED!**\n\nThank you for your purchase!\n💎 Keep buying to maintain Premium status.\n\nClick the button below to receive your product:`;
                
                await dm.send({ 
                    content: finalMsg, 
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("📥 Receive Product").setStyle(ButtonStyle.Link).setURL(product.file_download))] 
                });
                
                await sendReturnMessage(customer, "");
                
                // ARQUIVAR PRODUTO APENAS NA APROVAÇÃO FINAL
                await pool.query(`UPDATE products SET archived = TRUE WHERE id = $1`, [approvalData.productId]);
                await syncShowcase({ ...product, archived: true });
                
                await clearQueueAndNotifyBought(approvalData.productId, product.store);
                await registerPurchase(targetUserId);
                await sendToPortfolio(product, targetUserId);
                
                await mirrorToLog(targetUserId, '', 'delivery', { productId: product.id, store: product.store, tier: isPremium ? '💎 Premium' : '🌟 Basic', downloadUrl: product.file_download });
                
                // Atualizar Planilha de Vendas
                const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price;
                const priceVal = isPremium ? parseFloat(prices.premium_stripe.replace('$','')) : parseFloat(prices.basic_stripe.replace('$',''));
                updateSaleInSheet(approvalData.productId, targetUserId, approvalData.paymentMethod, approvalData.receiptUrl, 'Discord', 0, priceVal).catch(e => console.error("Sheet Update Error:", e));
                
                approvalData.processed = true; 
                approvalData.processedBy = interaction.user.username;
                await invalidateApprovalButtons(approvalData, `✅ Approved by ${interaction.user.username}. Product delivered.`);
            } catch (err) {}
            
            delete pendingApprovals[targetUserId];
            return interaction.editReply({ content: `✅ Approved & delivered! Product archived and added to portfolio.`, components: [] });
        }

        if (interaction.isButton() && interaction.customId.startsWith("confirm_deny_receipt_")) {
            await interaction.deferUpdate();
            const targetUserId = interaction.customId.replace("confirm_deny_receipt_", "");
            const approvalData = pendingApprovals[targetUserId];
            
            if (!approvalData) return interaction.editReply({ content: "❌ Expired.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            if (approvalData.processed) return interaction.editReply({ content: `⚠️ This action has already been processed by ${approvalData.processedBy}.`, components: [] });
            
            approvalData.attempts = (approvalData.attempts || 0) + 1;
            
            // --- LIBERAR PRODUTO SE REPROVADO ---
            try {
                // Desarquiva no Banco de Dados
                await pool.query(`UPDATE products SET archived = FALSE WHERE id = $1`, [approvalData.productId]);
                
                // Atualiza Planilha para "Disponível" novamente
                const jwtClient = await getJwtClient();
                const fullRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!A:R`, { 
                    headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}` } 
                });
                const fullData = await fullRes.json();
                const rows = fullData.values || [];
                let rowIndex = -1;
                for (let i = 1; i < rows.length; i++) {
                    if (rows[i][0] && rows[i][0].toString().trim() === approvalData.productId.toString().trim()) {
                        rowIndex = i + 1;
                        break;
                    }
                }
                if (rowIndex !== -1) {
                    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}!E${rowIndex}`, { 
                        method: 'PUT', 
                        headers: { 'Authorization': `Bearer ${jwtClient.credentials.access_token}`, 'Content-Type': 'application/json' }, 
                        body: JSON.stringify({ values: [['🟢 Disponível']] }) 
                    });
                }
                
                // Notificar próxima pessoa da fila que o produto voltou
                await notifyNextInQueue(approvalData.productId, approvalData.store);
                
            } catch (e) { console.error("Erro ao liberar produto reprovado:", e); }
            // ------------------------------------

            try {
                const customer = await client.users.fetch(targetUserId); 
                const dm = await customer.createDM();
                const remaining = MAX_RECEIPT_ATTEMPTS - approvalData.attempts;
                
                if (remaining > 0) await dm.send({ 
                    content: `❌ **PAYMENT DENIED**\n\nWe could not verify your payment. Please check if the payment was completed correctly.\n\nYou have **${remaining} attempt(s)** remaining to submit a new receipt.`, 
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("report_payment_lindens").setLabel("📄 Send New Receipt").setStyle(ButtonStyle.Primary), 
                        new ButtonBuilder().setCustomId("contact_support").setLabel("💬 Contact Support").setStyle(ButtonStyle.Secondary)
                    )] 
                });
                else { 
                    await dm.send({ 
                        content: `❌ **PAYMENT DENIED**\n\nAll receipt attempts have been exhausted. Please contact support for assistance.`, 
                        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("contact_support").setLabel("💬 Contact Support").setStyle(ButtonStyle.Primary))] 
                    }); 
                    delete pendingApprovals[targetUserId]; 
                }
                
                approvalData.processed = true; 
                approvalData.processedBy = interaction.user.username;
                await invalidateApprovalButtons(approvalData, `❌ Denied by ${interaction.user.username}. Customer notified.`);
            } catch (err) {}
            
            await mirrorToLog(targetUserId, `Payment denied (attempt ${approvalData.attempts}/${MAX_RECEIPT_ATTEMPTS})`, 'bot', { username: 'System' });
            return interaction.editReply({ content: `❌ Denied. Customer notified and product released.`, components: [] });
        }

        if (interaction.isButton() && interaction.customId.startsWith("approve_receipt_")) {
            const targetUserId = interaction.customId.replace("approve_receipt_", ""); 
            const approvalData = pendingApprovals[targetUserId];
            
            if (!approvalData) return interaction.reply({ content: "❌ Expired.", flags: [MessageFlags.Ephemeral], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            if (approvalData.processed) return interaction.reply({ content: `⚠️ Already processed by ${approvalData.processedBy}.`, flags: [MessageFlags.Ephemeral] });
            
            return interaction.reply({ 
                content: `⚠️ **CONFIRM APPROVAL?**\n\nYou are about to approve payment for <@${targetUserId}> and deliver the product.\n\nThis action cannot be undone.`, 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`confirm_approve_receipt_${targetUserId}`).setLabel("✅ Yes, Approve").setStyle(ButtonStyle.Success), 
                    new ButtonBuilder().setCustomId("cancel_action").setLabel("❌ No, Cancel").setStyle(ButtonStyle.Danger)
                )], 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        if (interaction.isButton() && interaction.customId.startsWith("deny_receipt_")) {
            const targetUserId = interaction.customId.replace("deny_receipt_", ""); 
            const approvalData = pendingApprovals[targetUserId];
            
            if (!approvalData) return interaction.reply({ content: "❌ Expired.", flags: [MessageFlags.Ephemeral], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            if (approvalData.processed) return interaction.reply({ content: `⚠️ Already processed by ${approvalData.processedBy}.`, flags: [MessageFlags.Ephemeral] });
            
            return interaction.reply({ 
                content: `⚠️ **CONFIRM DENIAL?**\n\nYou are about to deny payment for <@${targetUserId}>.\n\nThey will be notified and can resend proof if attempts remain.`, 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`confirm_deny_receipt_${targetUserId}`).setLabel("✅ Yes, Deny").setStyle(ButtonStyle.Danger), 
                    new ButtonBuilder().setCustomId("cancel_action").setLabel("❌ No, Cancel").setStyle(ButtonStyle.Secondary)
                )], 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        if (interaction.isButton() && interaction.customId === "cancel_action") return interaction.update({ content: "❌ Action cancelled.", components: [] });

        // ====================== ADMIN MODAL CREDITS ======================
        if (interaction.isModalSubmit() && interaction.customId.startsWith("admin_modal_credits_")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const action = interaction.customId.replace("admin_modal_credits_", ""); 
            const w = adminWizard[interaction.user.id];
            
            if (!w || !w.targetUserId) return interaction.editReply({ content: "❌ Session expired." });
            
            const amount = parseFloat(interaction.fields.getTextInputValue("amount")); 
            const reason = interaction.fields.getTextInputValue("reason");
            
            if (isNaN(amount) || amount <= 0) return interaction.editReply({ content: "❌ Invalid amount." });
            
            const oldBalance = await getCreditBalance(w.targetUserId, w.store);
            
            if (action === "add") await addCreditBalance(w.targetUserId, w.store, amount);
            else { 
                const success = await deductCreditBalance(w.targetUserId, w.store, amount); 
                if (!success) return interaction.editReply({ content: "❌ Insufficient funds." }); 
            }
            
            const newBalance = await getCreditBalance(w.targetUserId, w.store);
            
            await pool.query(`INSERT INTO admin_audit_logs (admin_id, target_user_id, action, old_value, new_value, reason) VALUES ($1, $2, $3, $4, $5, $6)`, [interaction.user.id, w.targetUserId, `CREDIT_${action.toUpperCase()}`, oldBalance.toString(), newBalance.toString(), reason]);
            
            const user = await client.users.fetch(w.targetUserId).catch(() => null);
            if (user) await updateClientProfileSheet(w.targetUserId, user.username, (await checkAndUpdateTier(w.targetUserId)).newTier, w.store, 0);
            
            try { 
                const targetUser = await client.users.fetch(w.targetUserId); 
                await targetUser.send(`💳 **Credit Update**\n${action === 'add' ? 'Added' : 'Removed'}: $${amount.toFixed(2)}\nReason: ${reason}\nNew Balance: $${newBalance.toFixed(2)}`); 
            } catch (e) {}
            
            await interaction.editReply({ content: `✅ Success! ${action === 'add' ? 'Added' : 'Removed'} $${amount.toFixed(2)}. New Balance: $${newBalance.toFixed(2)}` });
            return reopenAdminPanel(interaction, w);
        }

        // ====================== ADMIN ACTION TIER ======================
        if (interaction.isButton() && interaction.customId === "admin_action_tier") {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const w = adminWizard[interaction.user.id]; 
            if (!w || !w.targetUserId) return interaction.editReply({ content: "❌ Session expired." });
            
            const currentRes = await pool.query(`SELECT tier FROM customers WHERE user_id = $1`, [w.targetUserId]); 
            const currentTier = currentRes.rows[0]?.tier || 'basic';
            const newTier = currentTier === 'premium' ? 'basic' : 'premium';
            
            await pool.query(`UPDATE customers SET tier = $1, purchase_dates = '{}' WHERE user_id = $2`, [newTier, w.targetUserId]);
            
            const user = await client.users.fetch(w.targetUserId).catch(() => null); 
            if (user) await updateClientProfileSheet(w.targetUserId, user.username, newTier, w.store, 0);
            
            try { 
                const targetUser = await client.users.fetch(w.targetUserId); 
                const badge = newTier === 'premium' ? '💎 Premium' : '🌟 Basic'; 
                const msg = newTier === 'premium' ? `🔧 **Tier Update**\nYour tier in **${w.store.toUpperCase()}** has been changed to **${badge}** by an administrator.\nYour progress bar has been reset.` : `🔧 **Status Update**\nYour tier in **${w.store.toUpperCase()}** has been changed to **${badge}** by an administrator.`; 
                await targetUser.send(msg); 
            } catch (e) {}
            
            await interaction.editReply({ content: `✅ Tier changed to **${newTier.toUpperCase()}** for <@${w.targetUserId}>. Progress bar has been reset.` });
            return reopenAdminPanel(interaction, w);
        }

        // ====================== ADMIN ACTION HISTORY ======================
        if (interaction.isButton() && interaction.customId === "admin_action_history") {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const w = adminWizard[interaction.user.id]; 
            if (!w || !w.targetUserId) return interaction.editReply({ content: "❌ Session expired." });
            
            const history = await getUserPurchaseHistory(w.targetUserId, w.store);
            
            if (history.length === 0) await interaction.editReply({ content: `ℹ️ No purchase history found for this user in **${w.store.toUpperCase()}**.` });
            else { 
                let historyText = ""; 
                history.forEach(h => { 
                    let price = "$0.00"; 
                    if (typeof h.price === 'object') price = h.price.basic_stripe || "$0.00"; 
                    else price = `$${h.price}`; 
                    historyText += `• **${h.id}** (${price}) - ${h.date}\n`; 
                }); 
                await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`📜 Purchase History`).setDescription(historyText.substring(0, 4096)).setColor(0x3498db)] }); 
            }
            
            return reopenAdminPanel(interaction, w);
        }

        // ====================== ADMIN ACTION BAN ======================
        if (interaction.isButton() && interaction.customId === "admin_action_ban") {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const w = adminWizard[interaction.user.id]; 
            if (!w || !w.targetUserId) return interaction.editReply({ content: "❌ Session expired." });
            
            const customer = await ensureCustomer(w.targetUserId); 
            let blockedStores = customer.blocked_stores || []; 
            let msg = "";
            
            if (blockedStores.includes(w.store)) { 
                blockedStores = blockedStores.filter(s => s !== w.store); 
                msg = `✅ User <@${w.targetUserId}> has been **UNBLOCKED** from **${w.store.toUpperCase()}**.`; 
            }
            else { 
                blockedStores.push(w.store); 
                msg = `🚫 User <@${w.targetUserId}> has been **BLOCKED** from **${w.store.toUpperCase()}**.`; 
            }
            
            await pool.query(`UPDATE customers SET blocked_stores = $1 WHERE user_id = $2`, [blockedStores, w.targetUserId]);
            await interaction.editReply({ content: msg }); 
            return reopenAdminPanel(interaction, w);
        }

        // ====================== ADMIN QUEUE REMOVE ======================
        if (interaction.isButton() && interaction.customId.startsWith("admin_confirm_remove_queue_")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const fullSuffix = interaction.customId.replace("admin_confirm_remove_queue_", ""); 
            const firstUnderscore = fullSuffix.indexOf("_"); 
            const tUserId = fullSuffix.substring(0, firstUnderscore); 
            const pId = fullSuffix.substring(firstUnderscore + 1).replace(/_/g, ' ');
            
            await pool.query(`DELETE FROM queue_notifications WHERE user_id = $1 AND product_id = $2`, [tUserId, pId]);
            
            try { 
                const user = await client.users.fetch(tUserId); 
                await user.send(`❌ You have been removed from the queue for product **${pId}** by an administrator.`); 
            } catch (e) {}
            
            await interaction.editReply({ content: `✅ User removed from queue for **${pId}**.` });
            const w = adminWizard[interaction.user.id]; 
            if (w) return reopenAdminPanel(interaction, w);
        }

        if (interaction.isButton() && interaction.customId.startsWith("admin_queue_remove_all_")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const targetUserId = interaction.customId.replace("admin_queue_remove_all_", ""); 
            const w = adminWizard[interaction.user.id]; 
            if (!w) return interaction.editReply({ content: "❌ Session expired." });
            
            await pool.query(`DELETE FROM queue_notifications WHERE user_id = $1 AND product_id IN (SELECT id FROM products WHERE store = $2)`, [targetUserId, w.store]);
            
            try { 
                const user = await client.users.fetch(targetUserId); 
                await user.send(`🗑️ You have been removed from all queues in the **${w.store.toUpperCase()}** store by an administrator.`); 
            } catch (e) {}
            
            await interaction.editReply({ content: `✅ User removed from all queues in **${w.store.toUpperCase()}**.` }); 
            return reopenAdminPanel(interaction, w);
        }

        // ====================== EDITAR PRODUTO ======================
            if (interaction.isButton() && interaction.customId.startsWith("edit_action_")) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const w = adminWizard[interaction.user.id]; 
        if (!w || w.type !== "edit" || !w.productId) return interaction.editReply({ content: "❌ Sessão expirada.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
        
        const parts = interaction.customId.split("_"); 
        const action = parts[2]; 
        const prodId = parts.slice(3).join("_").replace(/_/g, ' ');

        // --- NOVA LÓGICA: ENVIAR PARA PORTFÓLIO ---
        if (action === "portfolio") {
            const product = (await pool.query(`SELECT * FROM products WHERE id = $1`, [prodId])).rows[0];
            if (!product) return interaction.editReply({ content: "❌ Produto não encontrado." });

            try {
                // 1. Marca como vendido/arquivado no DB
                await pool.query(`UPDATE products SET archived = TRUE WHERE id = $1`, [prodId]);
                
                // 2. Atualiza a Planilha para "Vendido" (usando Admin como comprador)
                await updateSaleInSheet(prodId, "ADMIN_MANUAL", "Portfolio", "", "Discord", 0, 0);

                // 3. Envia para o canal de Portfólio
                await sendToPortfolio(product, "admin_manual");

                // 4. Atualiza a vitrine (remove do showcase ativo)
                await syncShowcase({ ...product, archived: true });

                await interaction.editReply({ content: `🖼️ Produto **${prodId}** enviado para o Portfólio e marcado como vendido!`, components: [] });
                return reopenEditMenu(interaction, w, prodId);
            } catch (err) {
                console.error(err);
                return interaction.editReply({ content: `❌ Erro ao enviar para portfólio: ${err.message}` });
            }
        }
        // -----------------------------------------

        if (action === "archive") {
            // ... resto do código existente ...
                const newStatus = !w.productData.archived; 
                await pool.query(`UPDATE products SET archived = $1 WHERE id = $2`, [newStatus, prodId]); 
                const updatedProduct = (await pool.query(`SELECT * FROM products WHERE id = $1`, [prodId])).rows[0]; 
                await syncShowcase(updatedProduct); 
                await interaction.editReply({ content: `✅ Produto **${prodId}** foi ${newStatus ? 'arquivado' : 'desarquivado'} com sucesso!`, components: [] }); 
                return reopenEditMenu(interaction, w, prodId); 
            }
            
                   if (action === "delete") { 
            // 1. Verifica se existe um post no portfólio para este produto
            const forumChannel = client.channels.cache.get(PORTFOLIO_CHANNEL_ID);
            if (forumChannel) {
                try {
                    // Tenta buscar threads pelo nome do produto (já que salvamos o ID no nome da thread)
                    const activeThreads = await forumChannel.threads.fetchActive();
                    const targetThread = activeThreads.threads.find(t => t.name.includes(prodId));
                    
                    if (targetThread) {
                        await targetThread.delete();
                        console.log(`Portfólio thread for ${prodId} deleted.`);
                    }
                } catch (e) {
                    console.error("Erro ao limpar portfólio na exclusão:", e);
                }
            }

            // 2. Deleta do Banco de Dados e Filas
            await pool.query(`DELETE FROM products WHERE id = $1`, [prodId]); 
            await pool.query(`DELETE FROM queue_notifications WHERE product_id = $1`, [prodId]); 
            await pool.query(`UPDATE product_reservations SET status = 'EXPIRED' WHERE product_id = $1`, [prodId]); 
            
            delete adminWizard[interaction.user.id]; 
            
            return interaction.editReply({ 
                content: `🗑️ Produto **${prodId}** excluído permanentemente e removido do Portfólio!`, 
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("edit_back_to_list").setLabel("🔙 Ver Outros Produtos").setStyle(ButtonStyle.Secondary))] 
            }); 
        }
            
            if (action === "price") { 
                w.step = "waiting_for_net_amount_edit"; 
                w.editingProdId = prodId; 
                return interaction.editReply({ content: `💵 **Alterar Preço de ${prodId}**\n\nDigite o **VALOR LÍQUIDO** que deseja receber (ex: 100).\nO sistema calculará automaticamente os preços Basic e Premium.`, components: [] }); 
            }
            
            if (action === "image") { 
                w.step = "waiting_for_image"; 
                w.editingProdId = prodId; 
                return interaction.editReply({ content: "🖼️ Envie a nova imagem do produto (anexe o arquivo ou cole o link):", components: [] }); 
            }
            
            if (action === "download") { 
                w.step = "waiting_for_download"; 
                w.editingProdId = prodId; 
                return interaction.editReply({ content: "📥 Envie o novo link de download ou anexe o arquivo:", components: [] }); 
            }
        }

        if (interaction.isButton() && interaction.customId.startsWith("confirm_price_yes_")) {
            await interaction.deferUpdate();
            const w = adminWizard[interaction.user.id]; 
            if (!w || !w.tempPriceData) return interaction.editReply({ content: "❌ Sessão expirada.", components: [] });
            
            const prodId = w.editingProdId; 
            const data = w.tempPriceData;
            
            const newPrice = { basic_stripe: data.basic_stripe, basic_lindens: data.basic_lindens, premium_stripe: data.premium_stripe, premium_lindens: data.premium_lindens };
            await pool.query(`UPDATE products SET price = $1 WHERE id = $2`, [JSON.stringify(newPrice), prodId]);
            
            const prod = (await pool.query(`SELECT stripe_product_id, stripe_price_basic_id, stripe_price_premium_id FROM products WHERE id = $1`, [prodId])).rows[0];
            if (prod?.stripe_product_id) {
                const cs = stripeClients[w.store] || stripeClients.occult;
                try { 
                    if (prod.stripe_price_basic_id) await cs.prices.update(prod.stripe_price_basic_id, { active: false }); 
                    if (prod.stripe_price_premium_id) await cs.prices.update(prod.stripe_price_premium_id, { active: false }); 
                    const newBasic = await cs.prices.create({ product: prod.stripe_product_id, unit_amount: Math.round(data.stripe_raw * 100), currency: 'usd' }); 
                    const newPremium = await cs.prices.create({ product: prod.stripe_product_id, unit_amount: Math.round(data.stripe_raw * 0.97 * 100), currency: 'usd', nickname: 'Premium' }); 
                    await pool.query(`UPDATE products SET stripe_price_basic_id = $1, stripe_price_premium_id = $2 WHERE id = $3`, [newBasic.id, newPremium.id, prodId]); 
                } catch (e) {}
            }
            
            const updated = (await pool.query(`SELECT * FROM products WHERE id = $1`, [prodId])).rows[0]; 
            await syncShowcase(updated); 
            delete w.tempPriceData;
            
            await interaction.editReply({ content: `✅ Preço salvo! Líquido: $${data.net.toFixed(2)}`, components: [] }); 
            return reopenEditMenu(interaction, w, prodId);
        }

        if (interaction.isButton() && interaction.customId.startsWith("confirm_price_no_")) { 
            const w = adminWizard[interaction.user.id]; 
            if (!w) return interaction.update({ content: "❌ Sessão expirada.", components: [] }); 
            w.step = "waiting_for_net_amount_edit"; 
            delete w.tempPriceData; 
            return interaction.update({ content: `💵 Digite o novo **VALOR LÍQUIDO** desejado:`, components: [] }); 
        }

        if (interaction.isButton() && interaction.customId === "edit_back_to_list") { 
            await interaction.deferUpdate(); 
            const w = adminWizard[interaction.user.id]; 
            if (!w || !w.store) return interaction.editReply({ content: "❌ Sessão expirada." }); 
            w.step = "select_product"; 
            
            const filtered = (await pool.query(`SELECT * FROM products WHERE store = $1 ORDER BY id`, [w.store])).rows; 
            if (!filtered.length) return interaction.editReply({ content: "❌ Nenhum produto encontrado nesta loja." }); 
            
            const rows = []; 
            let row = new ActionRowBuilder(); 
            filtered.forEach(p => { 
                if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); } 
                row.addComponents(new ButtonBuilder().setCustomId(`edit_prod_${p.id.replace(/ /g, '_')}`).setLabel(p.id).setStyle(p.archived ? ButtonStyle.Secondary : ButtonStyle.Primary)); 
            }); 
            rows.push(row); 
            
            return interaction.editReply({ content: "Selecione um produto para editar:", components: rows }); 
        }

        // ====================== DEMAIS HANDLERS ======================
        if (interaction.isChatInputCommand() && interaction.commandName === "fila") { 
            const member = await interaction.guild.members.fetch(interaction.user.id); 
            if (interaction.guild.ownerId !== interaction.user.id && !member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ No permission.", flags: [MessageFlags.Ephemeral] }); 
            
            return interaction.reply({ 
                content: "📋 **Queue Management Panel**\nSelect the store to manage queues:", 
                flags: [MessageFlags.Ephemeral], 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("queue_store_occult").setLabel("🛒 Occult").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("queue_store_side").setLabel("🛒 Side").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("queue_store_oxs").setLabel("🛒 OccultSide").setStyle(ButtonStyle.Primary)
                )] 
            }); 
        }

        if (interaction.isChatInputCommand() && interaction.commandName === "lindens") { 
            const member = await interaction.guild.members.fetch(interaction.user.id); 
            if (interaction.guild.ownerId !== interaction.user.id && !member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ No permission.", flags: [MessageFlags.Ephemeral] }); 
            
            clientSession[interaction.user.id] = { step: "waiting_for_linden_rate" }; 
            return interaction.reply({ content: "💎 **Enter the current Linden Rate:** *(Example: 244)*", flags: [MessageFlags.Ephemeral] }); 
        }

        if (interaction.isChatInputCommand() && interaction.commandName === "credits") { 
            const member = await interaction.guild.members.fetch(interaction.user.id); 
            if (interaction.guild.ownerId !== interaction.user.id && !member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ No permission.", flags: [MessageFlags.Ephemeral] }); 
            
            return interaction.reply({ 
                content: "💳 **Credit Management Panel**\nSelect the store to manage:", 
                flags: [MessageFlags.Ephemeral], 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("credits_store_occult").setLabel("🛒 Occult").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("credits_store_side").setLabel("🛒 Side").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("credits_store_oxs").setLabel("🛒 OccultSide").setStyle(ButtonStyle.Primary)
                )] 
            }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("showcase_buy_")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const prodId = interaction.customId.replace("showcase_buy_", "").replace(/_/g, ' '); 
            const product = (await pool.query(`SELECT * FROM products WHERE id = $1`, [prodId])).rows[0];
            
            if (!product) return interaction.editReply({ content: "❌ This product is no longer available.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            
            clientSession[interaction.user.id] = { step: "product_view", product, lastActivity: Date.now() };
            const isPremium = (await checkAndUpdateTier(interaction.user.id)).newTier === 'premium'; 
            const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price;
            const priceDisplay = isPremium ? `💳 **Stripe:** ${prices.premium_stripe}\n💎 **Lindens:** ${prices.premium_lindens}` : `💳 **Stripe:** ${prices.basic_stripe}\n💎 **Lindens:** ${prices.basic_lindens}`;
            
            await mirrorToLog(interaction.user.id, `Clicked showcase buy for: ${product.id}`, 'bot', { username: interaction.user.username });
            
            try { 
                await (await interaction.user.createDM()).send({ 
                    embeds: [new EmbedBuilder().setTitle(`${product.id}`).setDescription(priceDisplay).setImage(product.image).setColor(isPremium ? 0xFFD700 : 0xffffff)], 
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("tech_info").setLabel("📐 Technical Information").setStyle(ButtonStyle.Primary), 
                        new ButtonBuilder().setCustomId("payment_method").setLabel("💳 Payment Method").setStyle(ButtonStyle.Success)
                    )] 
                }); 
                return interaction.editReply({ content: "✅ Check your DMs!" }); 
            } 
            catch (err) { 
                return interaction.editReply({ content: "️ I couldn't open a DM with you. Please enable DMs.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] }); 
            }
        }

        if (interaction.isButton() && interaction.customId === "start_new_order") { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const td = await checkAndUpdateTier(interaction.user.id); 
            await sendIntroDM(interaction.user, td.recentPurchasesCount > 0, td); 
            return interaction.editReply({ content: "✅ Check your DM!" }); 
        }

        // ====================== /PAINEL PÚBLICO ======================
        if (interaction.isChatInputCommand() && interaction.commandName === "painel") {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (interaction.guild.ownerId !== interaction.user.id && !member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ No permission.", flags: [MessageFlags.Ephemeral] });
            
            await interaction.reply({ 
                embeds: [new EmbedBuilder().setTitle("Welcome to Occult x Side").setDescription("Check your DMs or click below.").setColor(0x2ecc71)], 
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_purchase").setLabel("🛒 Start Purchase").setStyle(ButtonStyle.Primary))]
            });
            await sendIntroDM(interaction.user);
            return;
        }

        if (interaction.isButton() && interaction.customId === "start_purchase") { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const td = await checkAndUpdateTier(interaction.user.id); 
            await sendIntroDM(interaction.user, td.recentPurchasesCount > 0, td); 
            return interaction.editReply({ content: "✅ Check your DM!" }); 
        }

        if (interaction.isChatInputCommand() && interaction.commandName === "produto" && interaction.options.getSubcommand() === "criar") { 
            const member = await interaction.guild.members.fetch(interaction.user.id); 
            if (interaction.guild.ownerId !== interaction.user.id && !member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ No permission.", flags: [MessageFlags.Ephemeral] }); 
            
            adminWizard[interaction.user.id] = { type: "create", step: "store", data: {} }; 
            return interaction.reply({ 
                content: "Select the store:", 
                flags: [MessageFlags.Ephemeral], 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("create_store_occult").setLabel("🛒 Occult").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("create_store_side").setLabel("🛒 Side").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("create_store_occult_x_side").setLabel("🛒 OccultSide").setStyle(ButtonStyle.Primary)
                )] 
            }); 
        }

        if (interaction.isChatInputCommand() && interaction.commandName === "produto" && interaction.options.getSubcommand() === "editar") { 
            const member = await interaction.guild.members.fetch(interaction.user.id); 
            if (interaction.guild.ownerId !== interaction.user.id && !member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ No permission.", flags: [MessageFlags.Ephemeral] }); 
            
            adminWizard[interaction.user.id] = { type: "edit", step: "store" }; 
            return interaction.reply({ 
                content: "Select the store:", 
                flags: [MessageFlags.Ephemeral], 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("edit_store_occult").setLabel("🛒 Occult").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("edit_store_side").setLabel("🛒 Side").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("edit_store_occult_x_side").setLabel("🛒 OccultSide").setStyle(ButtonStyle.Primary)
                )] 
            }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("create_store_")) { 
            const w = adminWizard[interaction.user.id]; 
            if (!w || w.type !== "create") return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral] }); 
            
            w.data.store = interaction.customId.replace("create_store_", ""); 
            w.step = "net_amount"; 
            return interaction.reply({ content: "💵 Enter the **NET AMOUNT** you want to receive (e.g., 100):", flags: [MessageFlags.Ephemeral] }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("edit_store_")) { 
            await interaction.deferUpdate(); 
            const w = adminWizard[interaction.user.id]; 
            if (!w || w.type !== "edit") return interaction.editReply({ content: "❌ Session expired." }); 
            
            w.store = interaction.customId.replace("edit_store_", ""); 
            w.step = "select_product"; 
            
            const filtered = (await pool.query(`SELECT * FROM products WHERE store = $1 ORDER BY id`, [w.store])).rows; 
            if (!filtered.length) return interaction.editReply({ content: "❌ No products found." }); 
            
            const rows = []; 
            let row = new ActionRowBuilder(); 
            filtered.forEach(p => { 
                if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); } 
                row.addComponents(new ButtonBuilder().setCustomId(`edit_prod_${p.id.replace(/ /g, '_')}`).setLabel(p.id).setStyle(p.archived ? ButtonStyle.Secondary : ButtonStyle.Primary)); 
            }); 
            rows.push(row); 
            
            return interaction.editReply({ content: "Select the product:", components: rows }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("edit_prod_")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const w = adminWizard[interaction.user.id]; 
            if (!w || w.type !== "edit") return interaction.editReply({ content: "❌ Sessão expirada. Use /produto editar novamente.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            
            const prodId = interaction.customId.replace("edit_prod_", "").replace(/_/g, ' '); 
            const product = (await pool.query(`SELECT * FROM products WHERE id = $1 AND store = $2`, [prodId, w.store])).rows[0];
            
            if (!product) return interaction.editReply({ content: "❌ Produto não encontrado ou não pertence a esta loja.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            
            w.step = "editing_product"; 
            w.productId = prodId; 
            w.productData = product;
            
            const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price;
            const embed = new EmbedBuilder()
                .setTitle(`✏️ Editando: ${prodId}`)
                .setDescription(`Loja: **${w.store.toUpperCase()}**\nArquivado: ${product.archived ? 'Sim' : 'Não'}`)
                .addFields(
                    { name: "💳 Stripe Basic", value: prices.basic_stripe || 'N/A', inline: true }, 
                    { name: "💎 Lindens Basic", value: prices.basic_lindens || 'N/A', inline: true }, 
                    { name: "📥 Download", value: product.file_download ? `[Link](${product.file_download})` : 'N/A', inline: false }
                ).setColor(0xf39c12);
            
            return interaction.editReply({ 
                embeds: [embed], 
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`edit_action_price_${prodId.replace(/ /g, '_')}`).setLabel("💰 Alterar Preço").setStyle(ButtonStyle.Primary), 
                        new ButtonBuilder().setCustomId(`edit_action_image_${prodId.replace(/ /g, '_')}`).setLabel("🖼️ Alterar Imagem").setStyle(ButtonStyle.Secondary), 
                        new ButtonBuilder().setCustomId(`edit_action_download_${prodId.replace(/ /g, '_')}`).setLabel("📥 Alterar Download").setStyle(ButtonStyle.Secondary)
                    ), 
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`edit_action_archive_${prodId.replace(/ /g, '_')}`).setLabel(product.archived ? "📦 Desarquivar" : "🗄️ Arquivar").setStyle(ButtonStyle.Danger), 
                        new ButtonBuilder().setCustomId(`edit_action_delete_${prodId.replace(/ /g, '_')}`).setLabel("🗑️ Excluir Produto").setStyle(ButtonStyle.Danger)
                    ), 
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("edit_back_to_list").setLabel("🔙 Ver Outros Produtos").setStyle(ButtonStyle.Secondary)
                    )
                ] 
            });
        }

        if (interaction.isButton() && interaction.customId.startsWith("client_store_")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const store = interaction.customId.replace("client_store_", ""), uid = interaction.user.id;
            
            if (clientSession[uid]) { delete clientSession[uid].product; delete clientSession[uid].step; }
            clientSession[uid] = { step: "store", lastActivity: Date.now() }; 
            resetSessionTimer(uid);
            
            const tierInfo = await checkAndUpdateTier(uid);
            if (tierInfo.tierChanged) { 
                const dm = await (await client.users.fetch(uid)).createDM(); 
                if (tierInfo.newTier === 'premium' && !tierInfo.customer.first_premium_notified) await dm.send({ embeds: [new EmbedBuilder().setTitle("🎉 Congratulations!").setDescription(`You've become our **PREMIUM CUSTOMER**!`).setColor(0xFFD700)] }); 
                else if (tierInfo.newTier === 'basic' && tierInfo.oldTier === 'premium') await dm.send({ embeds: [new EmbedBuilder().setTitle("😔 Status Update").setDescription(`Downgraded to **BASIC**.`).setColor(0x95a5a6)] }); 
            }
            
            await ensureLogChannel(uid, interaction.user.username, store); 
            await mirrorToLog(uid, `Selected store: ${store.toUpperCase()}`, 'bot', { username: interaction.user.username });
            
            const storeCredits = await getCreditBalance(uid, store); 
            const creditLine = storeCredits > 0 ? `\n💳 **Store Credits:** $${storeCredits.toFixed(2)} available` : '';
            
            const filtered = (await pool.query(`SELECT * FROM products WHERE store = $1 AND archived = FALSE`, [store])).rows;
            if (!filtered.length) return interaction.editReply({ content: `❌ No products available in ${store}`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`contact_support_${store}`).setLabel("💬 Contact Support").setStyle(ButtonStyle.Primary))] });
            
            const rows = []; 
            let row = new ActionRowBuilder(); 
            filtered.forEach(p => { 
                if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); } 
                row.addComponents(new ButtonBuilder().setCustomId(`product_${store}_${p.id.replace(/ /g, '_')}`).setLabel(p.id).setStyle(ButtonStyle.Secondary)); 
            }); 
            rows.push(row); 
            rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`contact_support_${store}`).setLabel("💬 Contact Support").setStyle(ButtonStyle.Danger)));
            
            return interaction.editReply({ 
                content: `📦 Products in ${store}\nYour tier: ${tierInfo.newTier === 'premium' ? '💎 **PREMIUM**' : '🌟 **BASIC**'} | Recent purchases: **${tierInfo.recentPurchasesCount}**${creditLine}`, 
                components: rows 
            });
        }

        if (interaction.isButton() && interaction.customId.startsWith("product_")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            if (!clientSession[interaction.user.id]) clientSession[interaction.user.id] = { step: "store", lastActivity: Date.now() };
            
            let prodId = interaction.customId.substring(8).replace(/_/g, ' ');
            if (prodId.startsWith("occult x side ")) prodId = prodId.replace("occult x side ", ""); 
            else if (prodId.startsWith("occult ")) prodId = prodId.replace("occult ", ""); 
            else if (prodId.startsWith("side ")) prodId = prodId.replace("side ", "");
            
            const product = (await pool.query(`SELECT * FROM products WHERE id = $1`, [prodId])).rows[0];
            if (!product) return interaction.editReply({ content: `❌ Product not found.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            
            clientSession[interaction.user.id].product = product; 
            clientSession[interaction.user.id].store = product.store; 
            clientSession[interaction.user.id].selected_store = product.store;
            
            const isPremium = (await checkAndUpdateTier(interaction.user.id)).newTier === 'premium'; 
            const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price;
            const priceDisplay = isPremium ? `💳 **Stripe:** ${prices.premium_stripe}\n💎 **Lindens:** ${prices.premium_lindens}` : `💳 **Stripe:** ${prices.basic_stripe}\n💎 **Lindens:** ${prices.basic_lindens}`;
            
            await mirrorToLog(interaction.user.id, `Viewed product: ${product.id}`, 'bot', { username: interaction.user.username });
            
            return interaction.editReply({ 
                embeds: [new EmbedBuilder().setTitle(`${product.id}`).setDescription(priceDisplay).setImage(product.image).setColor(isPremium ? 0xFFD700 : 0xffffff)], 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("tech_info").setLabel("📐 Technical Information").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("payment_method").setLabel("💳 Payment Method").setStyle(ButtonStyle.Success)
                )] 
            });
        }

        if (interaction.isButton() && interaction.customId === "tech_info") { 
            const s = clientSession[interaction.user.id]; 
            if (!s?.product) return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] }); 
            if (!s.product.tech_images?.length) return interaction.reply({ content: "❌ No technical info available.", flags: [MessageFlags.Ephemeral] }); 
            
            await interaction.reply({ 
                content: "📐 **Technical Information**:", 
                embeds: s.product.tech_images.map((u, i) => new EmbedBuilder().setTitle(`Tech Info - ${s.product.id}`).setDescription(`Image ${i + 1}/${s.product.tech_images.length}`).setImage(u).setColor(0x3498db)), 
                flags: [MessageFlags.Ephemeral] 
            }); 
            await interaction.followUp({ 
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("back_to_product").setLabel("🔙 Back").setStyle(ButtonStyle.Secondary))], 
                flags: [MessageFlags.Ephemeral] 
            }); 
        }

       if (interaction.isButton() && interaction.customId === "payment_method") {
    try {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const s = clientSession[interaction.user.id];
        
        if (!s?.product) {
            return interaction.editReply({
                content: "❌ Session expired.",
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))]
            });
        }

        const customer = await ensureCustomer(interaction.user.id);
        const blockedStores = customer.blocked_stores || [];
        
        if (blockedStores.includes(s.product.store)) {
            return interaction.editReply({
                content: `🚫 **Access Denied**\nYou are currently blocked from purchasing in the **${s.product.store.toUpperCase()}** store.\nPlease contact support for more information.`,
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`contact_support_${s.product.store}`).setLabel("💬 Contact Support").setStyle(ButtonStyle.Primary))]
            });
        }

        // --- VERIFICAÇÃO DE DUPLICIDADE E RESERVA ATIVA (CORRIGIDO) ---
        const existingReservation = await pool.query(
            `SELECT * FROM product_reservations WHERE user_id = $1 AND product_id = $2 AND status IN ('ACTIVE', 'SITE_RESERVATION') AND expires_at > NOW()`,
            [interaction.user.id, s.product.id]
        );

        // CORREÇÃO DO ERRO: Adicionando 'const' antes de existingQueue
        const existingQueue = await pool.query(
            `SELECT * FROM queue_notifications WHERE user_id = $1 AND product_id = $2`,
            [interaction.user.id, s.product.id]
        );

        if (existingReservation.rows.length > 0) {
            // Usa o expires_at do banco para evitar erro de fuso horário ("3 horas")
            const expiresTs = Math.floor(new Date(existingReservation.rows[0].expires_at).getTime() / 1000);
            return interaction.editReply({
                content: `⚠️ **You already have this product reserved!**\nYou are in position **#1** and have until <t:${expiresTs}:R> to finalize payment.`,
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel(" Browse other products").setStyle(ButtonStyle.Secondary))]
            });
        }

        if (existingQueue.rows.length > 0) {
            const posRes = await pool.query(`SELECT * FROM get_user_queue_info($1, $2)`, [interaction.user.id, s.product.id]);
            const pos = posRes.rows.length > 0 ? posRes.rows[0].posicao : '?';
            return interaction.editReply({
                content: `⚠️ **You are already in the queue for this product!**\nYour current position is **#${pos}**. Please wait for your turn to be called via DM.`,
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel(" Browse other products").setStyle(ButtonStyle.Secondary))]
            });
        }
        // -------------------------------------------------------------

        await registerInteraction(interaction.user.id, s.product.id, s.product.store);
        
        // Tenta reservar (função atômica com LOCK)
        const reservation = await checkAndReserveProduct(interaction.user.id, s.product.id, s.product.store, 10);
        
        let position, waitTime;
        
        if (reservation.success) {
    position = 1;
    waitTime = 0;
    s.step = "waiting_for_payment_method";
    startPaymentSelectionTimer(interaction.user.id, s.product.id, s.product.store);
    
    // Remove da fila imediatamente após conseguir a reserva
    await pool.query('DELETE FROM queue_notifications WHERE user_id = $1 AND product_id = $2', [interaction.user.id, s.product.id]);
    await sendQueueLog('entry', { userId: interaction.user.id, productId: s.product.id, store: s.product.store, position: 1, waitTime: 0 });

    // CORREÇÃO DEFINITIVA DE FUSO: Usa UTC puro baseado no NOW() do sistema + 10min
// Isso elimina qualquer diferença entre DB, Servidor e Cliente Discord
const nowUtc = new Date();
const expiresDate = new Date(nowUtc.getTime() + (10 * 60 * 1000));
const expiresTs = Math.floor(expiresDate.getTime() / 1000);

await interaction.editReply({
    content: `✅ **You are #1!**\nThe product is now reserved exclusively for you for **10 minutes**.\nExpires at: <t:${expiresTs}:R>`,
    // ... mantenha os components aqui
});

            // CÁLCULO DE PREÇOS E BOTÕES
            const isPremium = (await checkAndUpdateTier(interaction.user.id)).newTier === 'premium';
            const prices = typeof s.product.price === 'string' ? JSON.parse(s.product.price) : s.product.price;
            
            let priceStripeRaw = isPremium ? parseFloat(prices.premium_stripe.replace('$', '')) : parseFloat(prices.basic_stripe.replace('$', ''));
            let priceLindensRaw = isPremium ? parseFloat(prices.premium_lindens.replace(/L\$|,/g, '')) : parseFloat(prices.basic_lindens.replace(/L\$|,/g, ''));
            
            const availableCredits = await getCreditBalance(interaction.user.id, s.product.store);
            let finalStripe = priceStripeRaw, finalLindens = priceLindensRaw, creditsToUse = 0, hasCredits = availableCredits > 0;
            
            if (hasCredits) {
                if (availableCredits >= priceStripeRaw) { 
                    creditsToUse = priceStripeRaw; 
                    finalStripe = 0; 
                    finalLindens = 0; 
                } else { 
                    creditsToUse = availableCredits; 
                    finalStripe = priceStripeRaw - availableCredits; 
                    const lindenRate = parseInt((await pool.query(`SELECT value FROM settings WHERE key = 'linden_rate'`)).rows[0]?.value || 244); 
                    finalLindens = Math.round(finalStripe * lindenRate); 
                }
            }
            
            const displayStripe = finalStripe > 0 ? `$${finalStripe.toFixed(2)}` : "Covered by Credits";
            const displayLindens = finalLindens > 0 ? `L$${finalLindens.toLocaleString()}` : "Covered by Credits";
            const creditInfo = hasCredits ? `\n💳 **Credits Available:** $${availableCredits.toFixed(2)} (Applied automatically)` : "";
            
            const buttons = [
                new ButtonBuilder().setCustomId("pay_stripe").setLabel(" 💳 Pay with Stripe").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("pay_lindens").setLabel("💎 Pay with Lindens").setStyle(ButtonStyle.Primary)
            ];
            
            if (availableCredits >= priceStripeRaw) buttons.push(new ButtonBuilder().setCustomId("pay_credits").setLabel("💳 Use Credits").setStyle(ButtonStyle.Secondary));
            
            await interaction.followUp({
                embeds: [new EmbedBuilder().setTitle('Payment Options').setColor(isPremium ? 0xFFD700 : 0x2ecc71).addFields(
                    { name: 'Method', value: '💳 Stripe\n💎 Lindens', inline: true },
                    { name: 'Price', value: `${displayStripe}\n${displayLindens}`, inline: true },
                    { name: 'Benefits', value: 'Standard\n+2min delivery', inline: true }
                ).setDescription(`Product: **${s.product.id}**${creditInfo}`).setFooter({ text: "Owner verification required before delivery" })],
                components: [new ActionRowBuilder().addComponents(buttons)],
                flags: [MessageFlags.Ephemeral]
            });
            
        // ... dentro de payment_method, após falhar na reserva ...
// ... dentro de if (interaction.isButton() && interaction.customId === "payment_method") { ... }
// No bloco ELSE (quando falha na reserva e vai para a fila)

} else {
    // Se falhou na reserva, vai para a fila
    await pool.query(`INSERT INTO queue_notifications (user_id, product_id, notified) VALUES ($1, $2, FALSE) ON CONFLICT DO NOTHING`, [interaction.user.id, s.product.id]);
    
    // CÁLCULO SEGURO VIA STORED PROCEDURE
    const posRes = await pool.query(`SELECT * FROM get_user_queue_info($1, $2)`, [interaction.user.id, s.product.id]); 
    
    const position = posRes.rows.length > 0 ? posRes.rows[0].posicao : '?';
    const waitTime = posRes.rows.length > 0 ? posRes.rows[0].wait_time_minutes : 0;
    
    await sendQueueLog('entry', { userId: interaction.user.id, productId: s.product.id, store: s.product.store, position, waitTime });
    
    return interaction.editReply({
        content: `📋 **Queue Position: #${position}**\n Estimated release in **~${waitTime} min**.`,
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`notify_me_${s.product.id.replace(/ /g, '_')}`).setLabel("🔔 Notify me if released").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Browse other products").setStyle(ButtonStyle.Secondary)
        )]
    });
}
    } catch (err) {
        console.error("PAYMENT METHOD ERROR:", err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "❌ Internal error processing request.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }
    }
}
        if (interaction.isButton() && interaction.customId.startsWith("notify_me_")) {
    const prodId = interaction.customId.replace("notify_me_", "").replace(/_/g, ' ');
    
    // Verifica se já está na fila ou tem reserva
    const inQueue = await pool.query(`SELECT * FROM queue_notifications WHERE user_id = $1 AND product_id = $2`, [interaction.user.id, prodId]);
    const hasReservation = await pool.query(`SELECT * FROM product_reservations WHERE user_id = $1 AND product_id = $2 AND status IN ('ACTIVE', 'SITE_RESERVATION') AND expires_at > NOW()`, [interaction.user.id, prodId]);

    if (inQueue.rows.length > 0 || hasReservation.rows.length > 0) {
        const posRes = await pool.query(`SELECT * FROM get_user_queue_info($1, $2)`, [interaction.user.id, prodId]);
        const pos = posRes.rows.length > 0 ? posRes.rows[0].posicao : (hasReservation.rows.length > 0 ? 1 : '?');
        
        return interaction.reply({ 
            content: `ℹ️ **You are already in the queue!**\nYour current position is **#${pos}**. You will be notified automatically when it's your turn.`, 
            flags: [MessageFlags.Ephemeral] 
        });
    }

    await pool.query(`INSERT INTO queue_notifications (user_id, product_id, notified) VALUES ($1, $2, FALSE) ON CONFLICT DO NOTHING`, [interaction.user.id, prodId]);
    const qCount = parseInt((await pool.query(`SELECT COUNT(*) as count FROM queue_notifications WHERE product_id = $1`, [prodId])).rows[0].count);
    const activeReservations = await getActiveQueueCount(prodId);
    const position = activeReservations + qCount;
    await interaction.reply({ content: `✅ Added to queue! Position: **#${position}**. You will be DM'd when available.`, flags: [MessageFlags.Ephemeral] });
}

        if (interaction.isButton() && interaction.customId.startsWith("queue_claim_")) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const prodId = interaction.customId.replace("queue_claim_", "").replace(/_/g, ' ');
    
    // Verifica se a reserva ainda está ativa
    const activeRes = await pool.query(
        `SELECT * FROM product_reservations WHERE user_id = $1 AND product_id = $2 AND status = 'ACTIVE' AND expires_at > NOW()`, 
        [interaction.user.id, prodId]
    );

    if (activeRes.rows.length === 0) {
        return interaction.editReply({ 
            content: `❌ **Reservation Expired**\nYour exclusive window to purchase **${prodId}** has ended. The product is now available to the next person in line.`, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Browse Other Products").setStyle(ButtonStyle.Secondary))] 
        });
    }

    const product = (await pool.query(`SELECT * FROM products WHERE id = $1`, [prodId])).rows[0];
    if (!product) return interaction.editReply({ content: " Product no longer available.", components: [] });

// Cancela o timer de tolerância de 3 minutos.
// A partir daqui, o usuário já assumiu a vaga.
if (clientSession[interaction.user.id]?.paymentTimeoutId) {
    clearTimeout(clientSession[interaction.user.id].paymentTimeoutId);
    delete clientSession[interaction.user.id].paymentTimeoutId;
}

// Mantém a mesma reserva e o mesmo expires_at.
// NÃO adicionamos mais 10 minutos.
clientSession[interaction.user.id] = {
    ...clientSession[interaction.user.id],
    step: "waiting_for_payment_method",
    product,
    lastActivity: Date.now()
};

    const isPremium = (await checkAndUpdateTier(interaction.user.id)).newTier === 'premium';
    const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price;
    let priceStripeRaw = isPremium ? parseFloat(prices.premium_stripe.replace('$', '')) : parseFloat(prices.basic_stripe.replace('$', ''));
    let priceLindensRaw = isPremium ? parseFloat(prices.premium_lindens.replace(/L\$|,/g, '')) : parseFloat(prices.basic_lindens.replace(/L\$|,/g, ''));
    const availableCredits = await getCreditBalance(interaction.user.id, product.store);
    let finalStripe = priceStripeRaw, finalLindens = priceLindensRaw, hasCredits = availableCredits > 0;
    
    if (hasCredits) {
        if (availableCredits >= priceStripeRaw) { finalStripe = 0; finalLindens = 0; }
        else { finalStripe = priceStripeRaw - availableCredits; const lindenRate = parseInt((await pool.query(`SELECT value FROM settings WHERE key = 'linden_rate'`)).rows[0]?.value || 244); finalLindens = Math.round(finalStripe * lindenRate); }
    }
    
    const displayStripe = finalStripe > 0 ? `$${finalStripe.toFixed(2)}` : "Covered by Credits";
    const displayLindens = finalLindens > 0 ? `L$${finalLindens.toLocaleString()}` : "Covered by Credits";
    const creditInfo = hasCredits ? `\n💳 **Credits Available:** $${availableCredits.toFixed(2)} (Applied automatically)` : "";
    
    const buttons = [
        new ButtonBuilder().setCustomId("pay_stripe").setLabel("💳 Pay with Stripe").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("pay_lindens").setLabel("💎 Pay with Lindens").setStyle(ButtonStyle.Primary)
    ];
    if (availableCredits >= priceStripeRaw) buttons.push(new ButtonBuilder().setCustomId("pay_credits").setLabel("💳 Use Credits").setStyle(ButtonStyle.Secondary));
    
    await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle('Payment Options').setColor(isPremium ? 0xFFD700 : 0x2ecc71).addFields(
            { name: 'Method', value: ' Stripe\n💎 Lindens', inline: true },
            { name: 'Price', value: `${displayStripe}\n${displayLindens}`, inline: true }
        ).setDescription(`Product: **${product.id}**${creditInfo}`).setFooter({ text: "Owner verification required before delivery" })],
        components: [new ActionRowBuilder().addComponents(buttons)]
    });
}

        if (interaction.isButton() && interaction.customId === "pay_stripe") {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    
    // VERIFICAÇÃO DO INTERRUPTOR GLOBAL 
    if (isStripeDisabled) {
        return interaction.editReply({ 
            content: "⚠️ **Pagamentos via Stripe estão temporariamente desativados.**\nPor favor, utilize Lindens ou Créditos da loja.", 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] 
        });
    }
    
    const s = clientSession[interaction.user.id];
    // ... resto do código existente ...
}
    const s = clientSession[interaction.user.id];
    
    if (!s || s.step !== "waiting_for_payment_method") {
        return interaction.editReply({ 
            content: "⚠️ Session expired or invalid.", 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] 
        });
    }

    const customer = await ensureCustomer(interaction.user.id);
    if ((customer.blocked_stores || []).includes(s.product.store)) {
        return interaction.editReply({ content: "🚫 Access Denied." });
    }

    // VERIFICAÇÃO DE SEGURANÇA DO CLIENTE STRIPE
    const stripeClient = stripeClients[s.product.store];
    if (!stripeClient) {
        console.error(` CRITICAL: Stripe client for ${s.product.store} is NULL! Check env vars.`);
        return interaction.editReply({ 
            content: `⚠️ Payment system temporarily unavailable for **${s.product.store.toUpperCase()}**. Please try again later.`, 
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel(" Start New Order").setStyle(ButtonStyle.Secondary))] 
        });
    }

    const isPremium = (await checkAndUpdateTier(interaction.user.id)).newTier === 'premium';
    const prices = typeof s.product.price === 'string' ? JSON.parse(s.product.price) : s.product.price;
    let priceRaw = isPremium ? parseFloat(prices.premium_stripe.replace('$', '')) : parseFloat(prices.basic_stripe.replace('$', ''));

    // Tratamento de produto gratuito ou erro de preço
    if (priceRaw <= 0) {
        await registerPurchase(interaction.user.id);
        updateSaleInSheet(s.product.id, interaction.user.id, "Free/Gift", "", "Discord", 0, 0).catch(e => {});
        const product = (await pool.query(`SELECT * FROM products WHERE id = $1`, [s.product.id])).rows[0];
        await sendToPortfolio(product, interaction.user.id);
        await syncShowcase({ ...product, archived: true });
        try {
            const dm = await interaction.user.createDM();
            await dm.send({
                content: `**✅ PURCHASE SUCCESSFUL!**\n\nThank you for your purchase!\n\nClick the button below to receive your product:`,
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("📥 Receive Product").setStyle(ButtonStyle.Link).setURL(product.file_download))]
            });
        } catch (e) { console.error("Failed to send DM delivery:", e); }
        await clearQueueAndNotifyBought(s.product.id, s.product.store);
        if (clientSession[interaction.user.id]?.paymentTimeoutId) clearTimeout(clientSession[interaction.user.id].paymentTimeoutId);
        delete clientSession[interaction.user.id];
        return interaction.editReply({
            content: "✅ Purchase successful! Check your DMs for the download link.",
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Primary))]
        });
    }

    const priceId = isPremium ? s.product.stripe_price_premium_id : s.product.stripe_price_basic_id;
    try {
        const session = await stripeClient.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            success_url: 'https://discord.com',
            cancel_url: 'https://discord.com',
            client_reference_id: interaction.user.id,
            metadata: { product_id: s.product.id, store: s.product.store, credits_used: 0 }
        });

        // BLINDAGEM DE URL
        let safeUrl = session.url;
        if (safeUrl && safeUrl.length > 512) {
            console.warn(`️ Stripe URL too long (${safeUrl.length} chars). Trimming parameters...`);
            const baseUrl = safeUrl.split('?')[0];
            const params = new URLSearchParams(safeUrl.split('?')[1]);
            const essentialParams = new URLSearchParams();
            ['session_id', 'locale'].forEach(key => {
                if (params.has(key)) essentialParams.set(key, params.get(key));
            });
            safeUrl = `${baseUrl}?${essentialParams.toString()}`;
            if (safeUrl.length > 512) {
                console.error(`❌ CRITICAL: URL still too long after trimming. Using dashboard fallback.`);
                safeUrl = `https://dashboard.stripe.com/payments/${session.payment_intent || 'search'}`;
            }
        }

        await interaction.editReply({
            content: `💳 Click below to pay **$${priceRaw.toFixed(2)}** via Stripe:`,
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Pay Now").setStyle(ButtonStyle.Link).setURL(safeUrl))]
        });
    } catch (err) {
        console.error("🔴 STRIPE SESSION ERROR:", err.message);
        console.error(" STRIPE TYPE:", err.type);
        console.error(" STRIPE PARAM:", err.param);
        await interaction.editReply({
            content: `⚠️ Stripe Error: ${err.message}`,
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel(" Start New Order").setStyle(ButtonStyle.Secondary))]
        });
    }
}
     
        if (interaction.isButton() && interaction.customId === "pay_lindens") {
            const s = clientSession[interaction.user.id]; 
            if (!s || s.step !== "waiting_for_payment_method") return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] });
            
            const customer = await ensureCustomer(interaction.user.id); 
            if ((customer.blocked_stores || []).includes(s.product.store)) return interaction.reply({ content: "🚫 Access Denied.", flags: [MessageFlags.Ephemeral] });
            
            const store = s.product.store; 
            const slUser = store === "occult" ? "@bbydott" : store === "side" ? "@itslev" : "@bbydott / @itslev";
            
            const isPremium = (await checkAndUpdateTier(interaction.user.id)).newTier === 'premium'; 
            const prices = typeof s.product.price === 'string' ? JSON.parse(s.product.price) : s.product.price; 
            const currentPriceLindens = isPremium ? prices.premium_lindens : prices.basic_lindens;
            
            await interaction.reply({ 
                content: `💎 **Lindens Payment**\n\nSend L$ to: \`${slUser}\`\nAmount: **${currentPriceLindens}**\n\nOnce paid, click **"Report Payment"** to submit receipt.`, 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("report_payment_lindens").setLabel("📄 Report Payment").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId("end_session").setLabel("❌ End Session").setStyle(ButtonStyle.Danger)
                )], 
                flags: [MessageFlags.Ephemeral] 
            });
        }

        if (interaction.isButton() && interaction.customId === "report_payment_lindens") { 
            const session = clientSession[interaction.user.id]; 
            if (!session || !session.product) return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] }); 
            
            clientSession[interaction.user.id].awaitingReceipt = { productId: session.product.id, store: session.product.store, paymentMethod: "Lindens", attempts: 0 }; 
            return interaction.reply({ 
                content: `📸 **Submit Receipt**\n\nSend .JPEG, .PNG, or .PDF now:`, 
                flags: [MessageFlags.Ephemeral] 
            }); 
        }

        // CORREÇÃO 1 & 2: COMPRA COM CRÉDITOS AGORA FUNCIONA COMPLETAMENTE
        if (interaction.isButton() && interaction.customId === "pay_credits") {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const s = clientSession[interaction.user.id]; 
            if (!s || s.step !== "waiting_for_payment_method") {
                return interaction.editReply({ 
                    content: "❌ Session expired.", 
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] 
                });
            }
            
            const customer = await ensureCustomer(interaction.user.id); 
            if ((customer.blocked_stores || []).includes(s.product.store)) {
                return interaction.editReply({ content: "🚫 Access Denied." });
            }
            
            const availableCredits = await getCreditBalance(interaction.user.id, s.product.store); 
            const isPremium = (await checkAndUpdateTier(interaction.user.id)).newTier === 'premium'; 
            const prices = typeof s.product.price === 'string' ? JSON.parse(s.product.price) : s.product.price; 
            const priceRaw = isPremium ? parseFloat(prices.premium_stripe.replace('$', '')) : parseFloat(prices.basic_stripe.replace('$', ''));
            
            if (availableCredits >= priceRaw) { 
                // 1. Deduzir créditos
                await deductCreditBalance(interaction.user.id, s.product.store, priceRaw); 
                // 2. Registrar compra no DB
                await registerPurchase(interaction.user.id); 
                // 3. Atualizar Planilha Vendas & Estoque (CORREÇÃO 4)
                updateSaleInSheet(s.product.id, interaction.user.id, "Credits", "", "Discord", priceRaw, 0).catch(e => console.error("Sheet Update Error:", e));
                // 4. Atualizar Perfil do Cliente (CORREÇÃO 5)
                const user = await client.users.fetch(interaction.user.id).catch(() => null);
                if (user) updateClientProfileSheet(interaction.user.id, user.username, isPremium ? 'premium' : 'basic', s.product.store, priceRaw).catch(e => {});
                // 5. Enviar para Portfólio
                const product = (await pool.query(`SELECT * FROM products WHERE id = $1`, [s.product.id])).rows[0]; 
                await sendToPortfolio(product, interaction.user.id); 
                // 6. Arquivar produto
                await syncShowcase({ ...product, archived: true }); 
                // 7. Limpar fila e notificar
                await clearQueueAndNotifyBought(s.product.id, s.product.store);
                // 8. Entregar produto na DM (CORREÇÃO 1)
                try {
                    const dm = await interaction.user.createDM();
                    await dm.send({ 
                        content: `**✅ PURCHASE SUCCESSFUL!**\n\nThank you for your purchase!\n\nClick the button below to receive your product:`, 
                        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("📥 Receive Product").setStyle(ButtonStyle.Link).setURL(product.file_download))] 
                    });
                } catch (e) {
                    console.error("Failed to send DM delivery:", e);
                }
                // 9. Responder na interação (sem "Check DMs")
                await interaction.editReply({ 
                    content: "✅ Purchase successful using credits!", 
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Primary))] 
                }); 
                // 10. PARAR TIMER DE INATIVIDADE (CORREÇÃO 2)
                if (clientSession[interaction.user.id]?.paymentTimeoutId) {
                    clearTimeout(clientSession[interaction.user.id].paymentTimeoutId);
                }
                // 11. Limpar sessão
                delete clientSession[interaction.user.id];
            } 
            else {
                await interaction.editReply({ 
                    content: `❌ Insufficient credits. You have $${availableCredits.toFixed(2)} but need $${priceRaw.toFixed(2)}.`, 
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] 
                });
            }
        }

        // ====================== FILA HANDLERS ======================
        if (interaction.isButton() && interaction.customId.startsWith("queue_store_")) { 
            const store = interaction.customId.replace("queue_store_", "").replace("oxs", "occult_x_side"); 
            const member = await interaction.guild.members.fetch(interaction.user.id); 
            if (interaction.guild.ownerId !== interaction.user.id && !member.roles.cache.has(ADMIN_ROLE_ID)) return interaction.reply({ content: "❌ No permission.", flags: [MessageFlags.Ephemeral] }); 
            
            return interaction.update({ 
                content: `📋 **Queue Management: ${store.toUpperCase()}**\nSelect an action:`, 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`queue_view_status_${store}`).setLabel("📊 View Queue Status").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId(`queue_manage_product_${store}`).setLabel("🔧 Manage Specific Product").setStyle(ButtonStyle.Secondary), 
                    new ButtonBuilder().setCustomId(`queue_reset_all_${store}`).setLabel("🔄 Reset All Queues").setStyle(ButtonStyle.Danger)
                )] 
            }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("queue_view_status_")) { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const store = interaction.customId.replace("queue_view_status_", ""); 
            const products = await pool.query(`SELECT id FROM products WHERE store = $1 AND archived = FALSE`, [store]); 
            let statusMsg = `📊 **Queue Status: ${store.toUpperCase()}**\n`; 
            let found = false; 
            for (const p of products.rows) { 
                const countRes = await pool.query(`SELECT COUNT(*) FROM queue_notifications WHERE product_id = $1`, [p.id]); 
                const count = parseInt(countRes.rows[0].count); 
                if (count > 0) { statusMsg += `📦 **${p.id}**: ${count} people waiting\n`; found = true; } 
            } 
            if (!found) statusMsg += "ℹ️ No active queues for available products."; 
            return interaction.editReply({ content: statusMsg }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("queue_manage_product_")) { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const store = interaction.customId.replace("queue_manage_product_", ""); 
            const products = await pool.query(`SELECT id FROM products WHERE store = $1 AND archived = FALSE`, [store]); 
            if (!products.rows.length) return interaction.editReply({ content: "❌ No available products." }); 
            
            const rows = []; 
            let row = new ActionRowBuilder(); 
            products.rows.forEach((p) => { 
                if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); } 
                row.addComponents(new ButtonBuilder().setCustomId(`queue_detail_${p.id.replace(/ /g, '_')}`).setLabel(p.id).setStyle(ButtonStyle.Secondary)); 
            }); 
            rows.push(row); 
            
            return interaction.editReply({ content: `🔧 **Select a product to manage:**`, components: rows }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("queue_detail_")) { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const prodId = interaction.customId.replace("queue_detail_", "").replace(/_/g, ' '); 
            const queueRes = await pool.query(`SELECT user_id FROM queue_notifications WHERE product_id = $1 ORDER BY joined_at ASC`, [prodId]); 
            const reservationRes = await pool.query(`SELECT user_id FROM product_reservations WHERE product_id = $1 AND status = 'ACTIVE' ORDER BY reserved_at ASC LIMIT 1`, [prodId]); 
            
            let detailMsg = `🔧 **Queue Management: ${prodId}**\n`; 
            if (reservationRes.rows.length > 0) detailMsg += `✅ **Reserved (1st Place):**\n<@${reservationRes.rows[0].user_id}> (ID: ${reservationRes.rows[0].user_id})\n`; 
            if (queueRes.rows.length > 0) { 
                detailMsg += `📋 **Waiting:**\n`; 
                queueRes.rows.forEach((r, i) => { detailMsg += `${i + 1}º <@${r.user_id}> (ID: ${r.user_id})\n`; }); 
            } else detailMsg += "📭 **Waiting:** No one.\n"; 
            
            return interaction.editReply({ 
                content: detailMsg, 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`queue_remove_specific_${prodId.replace(/ /g, '_')}`).setLabel("❌ Remove Specific User").setStyle(ButtonStyle.Danger), 
                    new ButtonBuilder().setCustomId(`queue_remove_all_${prodId.replace(/ /g, '_')}`).setLabel("🗑️ Remove All").setStyle(ButtonStyle.Danger)
                )] 
            }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("queue_remove_specific_")) { 
            const prodId = interaction.customId.replace("queue_remove_specific_", "").replace(/_/g, ' '); 
            const modal = new ModalBuilder().setCustomId(`modal_remove_user_${prodId.replace(/ /g, '_')}`).setTitle(`Remove User from ${prodId}`).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('target_user_id').setLabel('User ID to Remove').setStyle(TextInputStyle.Short).setRequired(true))); 
            return interaction.showModal(modal); 
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith("modal_remove_user_")) { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const prodId = interaction.customId.replace("modal_remove_user_", "").replace(/_/g, ' '); 
            const targetUserId = interaction.fields.getTextInputValue('target_user_id'); 
            
            await pool.query(`DELETE FROM queue_notifications WHERE product_id = $1 AND user_id = $2 RETURNING *`, [prodId, targetUserId]); 
            await pool.query(`UPDATE product_reservations SET status = 'EXPIRED' WHERE product_id = $1 AND user_id = $2 AND status = 'ACTIVE'`, [prodId, targetUserId]); 
            
            try { 
                const user = await client.users.fetch(targetUserId); 
                await user.send(`❌ You have been removed from the queue for product **${prodId}** by an administrator.`); 
            } catch (e) {} 
            
            const nextUsers = await pool.query(`SELECT user_id FROM queue_notifications WHERE product_id = $1 ORDER BY joined_at ASC`, [prodId]); 
            for (let i = 0; i < nextUsers.rows.length; i++) { 
                try { 
                    const u = await client.users.fetch(nextUsers.rows[i].user_id); 
                    await u.send(`🔄 Your position in the queue for **${prodId}** has changed! You are now **#${i + 1}**.`); 
                } catch (e) {} 
            } 
            
            const hasReservation = await pool.query(`SELECT COUNT(*) FROM product_reservations WHERE product_id = $1 AND status = 'ACTIVE'`, [prodId]); 
            if (parseInt(hasReservation.rows[0].count) === 0 && nextUsers.rows.length > 0) { 
                const pRes = await pool.query(`SELECT store FROM products WHERE id = $1`, [prodId]); 
                if (pRes.rows.length) await notifyNextInQueue(prodId, pRes.rows[0].store); 
            } 
            
            return interaction.editReply({ content: `✅ User <@${targetUserId}> removed from queue. Notifications sent.` }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("queue_remove_all_")) { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const prodId = interaction.customId.replace("queue_remove_all_", "").replace(/_/g, ' '); 
            const pRes = await pool.query(`SELECT store FROM products WHERE id = $1`, [prodId]); 
            const store = pRes.rows.length ? pRes.rows[0].store : 'occult'; 
            await resetQueueManually(prodId, store); 
            return interaction.editReply({ content: `✅ All users removed from queue for **${prodId}**.` }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("queue_reset_all_")) { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const store = interaction.customId.replace("queue_reset_all_", ""); 
            const products = await pool.query(`SELECT id FROM products WHERE store = $1 AND archived = FALSE`, [store]); 
            let cleared = 0; 
            for (const p of products.rows) { 
                await resetQueueManually(p.id, store); 
                cleared++; 
            } 
            return interaction.editReply({ content: `✅ Queues reset for ${cleared} products in **${store.toUpperCase()}**.` }); 
        }

        // ====================== ADMIN CLIENTE ACTIONS ======================
        if (interaction.isButton() && interaction.customId === "admin_action_credits") { 
            const w = adminWizard[interaction.user.id]; 
            if (!w || !w.targetUserId) return interaction.reply({ content: "❌ Session expired. Use /admin-cliente again.", flags: [MessageFlags.Ephemeral] }); 
            
            const select = new StringSelectMenuBuilder()
                .setCustomId(`admin_select_credit_action_${w.targetUserId}`)
                .setPlaceholder('Select Action: Add or Remove')
                .addOptions(
                    { label: 'Add Credits', value: 'add', description: 'Add balance to user', emoji: '➕' }, 
                    { label: 'Remove Credits', value: 'remove', description: 'Deduct balance from user', emoji: '➖' }
                ); 
            
            return interaction.reply({ content: "💳 **Credit Management**\nSelect an action:", components: [new ActionRowBuilder().addComponents(select)], flags: [MessageFlags.Ephemeral] }); 
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith("admin_select_credit_action_")) { 
            const targetUserId = interaction.customId.replace("admin_select_credit_action_", ""); 
            const action = interaction.values[0]; 
            const w = adminWizard[interaction.user.id]; 
            if (!w) return; 
            
            const modal = new ModalBuilder()
                .setCustomId(`admin_modal_credits_${action}`)
                .setTitle(`${action === 'add' ? 'Add' : 'Remove'} Credits for ${targetUserId}`)
                .addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Amount').setStyle(TextInputStyle.Short).setRequired(true)), 
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Short).setRequired(true))
                ); 
            
            return interaction.showModal(modal); 
        }

        if (interaction.isButton() && interaction.customId === "admin_action_reset_queue") { 
            const w = adminWizard[interaction.user.id]; 
            if (!w || !w.targetUserId) return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral] }); 
            
            return interaction.reply({ 
                content: `🔄 **Queue Management for <@${w.targetUserId}>**\nSelect an action:`, 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`admin_queue_view_${w.targetUserId}`).setLabel("👁️ View All Queues").setStyle(ButtonStyle.Primary), 
                    new ButtonBuilder().setCustomId(`admin_queue_remove_specific_${w.targetUserId}`).setLabel("❌ Remove from Specific Product").setStyle(ButtonStyle.Danger), 
                    new ButtonBuilder().setCustomId(`admin_queue_remove_all_${w.targetUserId}`).setLabel("🗑️ Remove from ALL Queues").setStyle(ButtonStyle.Danger)
                )], 
                flags: [MessageFlags.Ephemeral] 
            }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("admin_queue_view_")) { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const targetUserId = interaction.customId.replace("admin_queue_view_", ""); 
            const w = adminWizard[interaction.user.id]; 
            if (!w) return interaction.editReply({ content: "❌ Session expired." }); 
            
            const queues = await pool.query(`SELECT q.product_id, q.joined_at, p.store FROM queue_notifications q JOIN products p ON q.product_id = p.id WHERE q.user_id = $1 ORDER BY q.joined_at ASC`, [targetUserId]); 
            if (queues.rows.length === 0) return interaction.editReply({ content: "ℹ️ User is not in any queue." }); 
            
            let msg = `📋 **Queue Positions for <@${targetUserId}>**\n`; 
            queues.rows.forEach((q) => { msg += `📦 **${q.product_id}** (${q.store.toUpperCase()})\nJoined: ${formatBrasiliaDate(new Date(q.joined_at))}\n`; }); 
            
            return interaction.editReply({ content: msg }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("admin_queue_remove_specific_")) { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const targetUserId = interaction.customId.replace("admin_queue_remove_specific_", ""); 
            const w = adminWizard[interaction.user.id]; 
            if (!w) return interaction.editReply({ content: "❌ Session expired." }); 
            
            const queues = await pool.query(`SELECT q.product_id FROM queue_notifications q JOIN products p ON q.product_id = p.id WHERE q.user_id = $1 AND p.store = $2`, [targetUserId, w.store]); 
            if (queues.rows.length === 0) return interaction.editReply({ content: "ℹ️ User is not in any queue for this store." }); 
            
            const rows = []; 
            let row = new ActionRowBuilder(); 
            queues.rows.forEach((q) => { 
                if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); } 
                row.addComponents(new ButtonBuilder().setCustomId(`admin_confirm_remove_queue_${targetUserId}_${q.product_id.replace(/ /g, '_')}`).setLabel(q.product_id).setStyle(ButtonStyle.Danger)); 
            }); 
            rows.push(row); 
            
            return interaction.editReply({ content: `❌ **Select a product to remove <@${targetUserId}> from:**`, components: rows }); 
        }

        // ====================== SUPPORT HANDLERS ======================
        if (interaction.isButton() && interaction.customId.startsWith("contact_support_")) { 
            const store = interaction.customId.replace("contact_support_", ""); 
            const uid = interaction.user.id; 
            if (!clientSession[uid]) clientSession[uid] = {}; 
            clientSession[uid].selected_store = store; 
            clientSession[uid].store = store; 
            
            await mirrorToLog(uid, `Opened Support Menu for ${store.toUpperCase()}`, 'bot', { username: interaction.user.username });
            
            return interaction.reply({ 
                content: "🆘 **Support Center**\nPlease select the reason for your contact:", 
                flags: [MessageFlags.Ephemeral], 
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`support_refund_${store}`).setLabel("💸 Refund Request").setStyle(ButtonStyle.Danger), 
                    new ButtonBuilder().setCustomId(`support_other_${store}`).setLabel("❓ Other Issue").setStyle(ButtonStyle.Secondary)
                )] 
            }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("support_")) { 
            const parts = interaction.customId.split("_"); 
            const type = parts[1]; 
            let store = parts[2]; 
            if (clientSession[interaction.user.id]?.store) store = clientSession[interaction.user.id].store; 
            if (!clientSession[interaction.user.id]) clientSession[interaction.user.id] = {}; 
            clientSession[interaction.user.id].selected_store = store; 
            clientSession[interaction.user.id].store = store; 
            
            await mirrorToLog(interaction.user.id, `Selected Support Type: ${type.toUpperCase()} for ${store.toUpperCase()}`, 'bot', { username: interaction.user.username });
            
            if (type === "refund") { 
                const uid = interaction.user.id; 
                const recentProducts = await getRecentInteractions(uid, store); 
                if (recentProducts.length === 0) { 
                    clientSession[uid] = { step: "waiting_for_refund_reason", store: store, selected_store: store, lastActivity: Date.now() }; 
                    return interaction.reply({ 
                        content: "💸 **Refund Request**\n⚠️ **Only for undelivered items.**\nWe couldn't find any recent interactions (last 2 days) for this store.\nPlease describe briefly why you are requesting a refund and include the Product ID:", 
                        flags: [MessageFlags.Ephemeral], 
                        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] 
                    }); 
                } 
                const buttons = recentProducts.map(h => new ButtonBuilder().setCustomId(`refund_select_${h.id.replace(/ /g, '_')}`).setLabel(`${h.id}`).setStyle(ButtonStyle.Secondary)); 
                buttons.push(new ButtonBuilder().setCustomId("refund_manual_entry").setLabel("❓ Other Product").setStyle(ButtonStyle.Primary)); 
                
                return interaction.reply({ 
                    content: "💸 **Refund Request**\n⚠️ **Only for undelivered items.**\nSelect the product you want to refund (from last 2 days):", 
                    flags: [MessageFlags.Ephemeral], 
                    components: [new ActionRowBuilder().addComponents(buttons)] 
                }); 
            } else { 
                clientSession[interaction.user.id] = { step: "waiting_for_other_issue", store: store, selected_store: store, lastActivity: Date.now() }; 
                return interaction.reply({ 
                    content: "❓ **Other Issue**\nPlease describe your problem:", 
                    flags: [MessageFlags.Ephemeral], 
                    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] 
                }); 
            } 
        }

        if (interaction.isButton() && interaction.customId.startsWith("refund_select_")) { 
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const prodId = interaction.customId.replace("refund_select_", "").replace(/_/g, ' '); 
            const uid = interaction.user.id; 
            const store = clientSession[uid]?.selected_store || clientSession[uid]?.store; 
            
            if (!store) return interaction.editReply({ content: "❌ Could not determine store context. Please restart support.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] }); 
            
            await mirrorToLog(uid, `Selected Refund Product: ${prodId}`, 'bot', { username: interaction.user.username });
            
            const prodRes = await pool.query(`SELECT * FROM products WHERE id = $1`, [prodId]); 
            if (!prodRes.rows.length) return interaction.editReply({ content: "❌ Product not found in database.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] }); 
            
            const product = prodRes.rows[0]; 
            if (product.store !== store) return interaction.editReply({ content: `❌ Error: Product ${prodId} belongs to ${product.store.toUpperCase()}, not ${store.toUpperCase()}. Please select the correct store.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] }); 
            
            const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price; 
            const tierInfo = await checkAndUpdateTier(uid); 
            const isPremium = tierInfo.newTier === 'premium'; 
            
            let refundAmount = 0, displayPrice = ""; 
            if (isPremium && prices.premium_stripe) { refundAmount = parseFloat(prices.premium_stripe.replace('$', '')); displayPrice = prices.premium_stripe; } 
            else if (prices.basic_stripe) { refundAmount = parseFloat(prices.basic_stripe.replace('$', '')); displayPrice = prices.basic_stripe; } 
            
            clientSession[uid] = { 
                step: "waiting_for_refund_reason_with_product", 
                refundAmount, 
                refundProductId: prodId, 
                refundDisplayPrice: displayPrice, 
                store, 
                selected_store: store, 
                lastActivity: Date.now() 
            }; 
            
            const embed = new EmbedBuilder()
                .setTitle('💸 Refund Request Details')
                .addFields(
                    { name: '📦 Product', value: `**${prodId}**`, inline: true }, 
                    { name: '💰 Value', value: `**${displayPrice}**`, inline: true }, 
                    { name: '🏪 Store', value: `**${store.toUpperCase()}**`, inline: true }
                ).setColor(0xf1c40f)
                .setFooter({ text: 'Awaiting your response...' }); 
            
            return interaction.editReply({ 
                content: "Please describe the reason for your refund request below.\n💡 *Tip: Attach photos in the SAME message to speed up analysis.*", 
                embeds: [embed], 
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] 
            }); 
        }

        if (interaction.isButton() && interaction.customId === "refund_manual_entry") { 
            const store = clientSession[interaction.user.id]?.selected_store || clientSession[interaction.user.id]?.store; 
            clientSession[interaction.user.id] = { step: "waiting_for_refund_reason", store, selected_store: store, lastActivity: Date.now() }; 
            return interaction.update({ 
                content: "**Manual Refund Request**\n️ **Only for undelivered items.**\nPlease describe the issue and provide the exact Product ID and Value:", 
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] 
            }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("refund_method_")) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
            const parts = interaction.customId.split("_"); 
            const method = parts[2]; 
            const prodId = parts.slice(3).join("_").replace(/_/g, ' '); 
            const uid = interaction.user.id; 
            const store = clientSession[uid]?.store; 
            
            if (!store) return interaction.editReply({ content: "❌ Could not determine store context." });
            
            await mirrorToLog(uid, `Requested Refund Method: ${method} for ${prodId}`, 'bot', { username: interaction.user.username });
            
            const ownerIds = SUPPORT_DMS[store] || [ID_OCCULTSIDE_OFFICIAL]; 
            let methodText = method === "credit" ? "Store Credit (Fast)" : "Original Currency (Slow)"; 
            const refundAmount = clientSession[uid]?.refundAmount || 0; 
            const refundReason = clientSession[uid]?.refundReason || "No reason provided."; 
            const refundImages = clientSession[uid]?.refundImages || [];
            
            try {
                const ticket = await pool.query(`INSERT INTO support_tickets (user_id, store, type, reason, method, status) VALUES ($1, $2, 'refund', $3, $4, 'PENDING') RETURNING id`, [uid, store, prodId, method]); 
                const ticketId = ticket.rows[0].id; 
                const user = await client.users.fetch(uid).catch(() => null); 
                const username = user ? user.username : uid; 
                
                // CORREÇÃO 5: Logar reembolso na planilha
                await logRefundToSheet(uid, username, store, prodId, refundAmount, method, refundReason);
                
                for (const ownerId of ownerIds) {
                    try {
                        const owner = await client.users.fetch(ownerId); 
                        const embed = new EmbedBuilder()
                            .setTitle(`💸 Refund Request (${store.toUpperCase()})`)
                            .setDescription(`<@${uid}> wants a refund.`)
                            .addFields(
                                { name: "Reason/Product", value: prodId }, 
                                { name: "Preferred Method", value: methodText }, 
                                { name: "💰 Refund Amount", value: `$${refundAmount.toFixed(2)}`, inline: false }, 
                                { name: "Reason", value: refundReason.substring(0, 1024) }
                            ).setColor(0xf1c40f); 
                        
                        if (refundImages.length > 0) embed.setImage(refundImages[0]);
                        
                        let components = []; 
                        if (method === 'credit') components = [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`approve_refund_${ticketId}_${uid}_${store}`).setLabel("✅ Approve Credit").setStyle(ButtonStyle.Success), 
                            new ButtonBuilder().setCustomId(`deny_refund_${ticketId}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
                        )]; 
                        else components = [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setLabel("Open Dashboard").setStyle(ButtonStyle.Link).setURL("https://dashboard.stripe.com/payments"), 
                            new ButtonBuilder().setCustomId(`mark_resolved_${ticketId}`).setLabel("✅ Mark as Resolved").setStyle(ButtonStyle.Success)
                        )];
                        
                        const msg = await owner.send({ embeds: [embed], components }); 
                        if (refundImages.length > 1) for (let i = 1; i < refundImages.length; i++) await owner.send({ content: `Additional evidence ${i}:`, files: [refundImages[i]] });
                    } catch (e) { 
                        console.error(`Erro ao notificar owner ${ownerId} para ticket ${ticketId}:`, e); 
                    }
                }
                
                await interaction.editReply({ content: "✅ Refund request sent to the owner. Please wait for confirmation." });
            } catch (e) { 
                console.error("Erro crítico no suporte:", e);
                await interaction.editReply({ content: "❌ Error sending request. Please try again later.", components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] }); 
            }
            
            delete clientSession[uid];
        }

        // ====================== APPROVE/DENY REFUND ======================
        if (interaction.isButton() && interaction.customId.startsWith("approve_refund_")) { 
            await interaction.deferUpdate(); 
            const parts = interaction.customId.split("_"); 
            const ticketId = parts[2], targetUserId = parts[3], store = parts[4]; 
            let finalStore = store; 
            
            if (!finalStore) { 
                const tc = await pool.query(`SELECT store FROM support_tickets WHERE id = $1`, [ticketId]); 
                if (tc.rows.length > 0) finalStore = tc.rows[0].store; 
            } 
            
            const ticketRes = await pool.query(`SELECT * FROM support_tickets WHERE id = $1`, [ticketId]); 
            if (!ticketRes.rows.length) return interaction.editReply({ content: "Ticket not found.", components: [] }); 
            
            const ticket = ticketRes.rows[0]; 
            let finalAmount = 0, prodIdToSearch = ""; 
            
            if (ticket.reason.startsWith('#')) { 
                const fullReasonTrimmed = ticket.reason.trim(); 
                const checkFull = await pool.query(`SELECT price FROM products WHERE id = $1`, [fullReasonTrimmed]); 
                if (checkFull.rows.length > 0) prodIdToSearch = fullReasonTrimmed; 
                else { 
                    const allProds = await pool.query(`SELECT id, price FROM products WHERE store = $1 AND archived = FALSE`, [finalStore]); 
                    for (const p of allProds.rows) { 
                        if (ticket.reason.includes(p.id)) { prodIdToSearch = p.id; break; } 
                    } 
                } 
            } 
            
            if (prodIdToSearch) { 
                const prodRes = await pool.query(`SELECT price FROM products WHERE id = $1`, [prodIdToSearch]); 
                if (prodRes.rows.length) { 
                    const p = JSON.parse(prodRes.rows[0].price); 
                    const userInfo = await checkAndUpdateTier(targetUserId); 
                    if (userInfo.newTier === 'premium' && p.premium_stripe) finalAmount = parseFloat(p.premium_stripe.replace('$', '')); 
                    else finalAmount = parseFloat(p.basic_stripe.replace('$', '')); 
                } 
            } else { 
                const match = ticket.reason.match(/\d+(\.\d+)?/); 
                if (match) finalAmount = parseFloat(match[0]); 
            } 
            
            if (ticket.method === 'credit') { 
                if (finalAmount > 0) { 
                    await addCreditBalance(targetUserId, finalStore, finalAmount, true); 
                    await pool.query(`UPDATE support_tickets SET status = 'APPROVED' WHERE id = $1`, [ticketId]); 
                    updateRefundStatusInSheet(ticketId, '✅ Aprovado', interaction.user.username).catch(e => {}); 
                    
                    try { 
                        const user = await client.users.fetch(targetUserId); 
                        await user.send({ 
                            content: `✅ **Refund Approved!**\n$${finalAmount.toFixed(2)} has been added to your wallet in **${finalStore.toUpperCase()}**.\n*Note: This credit will free up a refund slot once spent.*`, 
                            components: [new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Primary), 
                                new ButtonBuilder().setCustomId(`contact_support_${finalStore}`).setLabel("💬 Contact Support").setStyle(ButtonStyle.Primary)
                            )] 
                        }); 
                    } catch (e) {} 
                    
                    return interaction.editReply({ content: `✅ Refund approved! $${finalAmount.toFixed(2)} credited to user in **${finalStore.toUpperCase()}**.`, components: [] }); 
                } else return interaction.editReply({ content: `❌ Error: Could not determine refund amount. Reason received: "${ticket.reason}"`, components: [] }); 
            } 
        }

        if (interaction.isButton() && interaction.customId.startsWith("deny_refund_")) { 
            await interaction.deferUpdate(); 
            const ticketId = interaction.customId.replace("deny_refund_", ""); 
            const ticketRes = await pool.query(`SELECT * FROM support_tickets WHERE id = $1`, [ticketId]); 
            
            if (ticketRes.rows.length > 0) { 
                const ticket = ticketRes.rows[0]; 
                await pool.query(`UPDATE support_tickets SET status = 'DENIED' WHERE id = $1`, [ticketId]); 
                updateRefundStatusInSheet(ticketId, '❌ Negado', interaction.user.username).catch(e => {}); 
                
                try { 
                    const user = await client.users.fetch(ticket.user_id); 
                    await user.send({ 
                        content: `❌ **Refund Denied**\nYour refund request for **${ticket.reason}** has been denied.\nThe store owner will contact you shortly with further explanations.`, 
                        components: [new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`contact_support_${ticket.store}`).setLabel("💬 Contact Support").setStyle(ButtonStyle.Primary), 
                            new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary)
                        )] 
                    }); 
                } catch (e) {} 
            } 
            
            return interaction.editReply({ content: `❌ Refund denied. Customer has been notified.`, components: [] }); 
        }

        if (interaction.isButton() && interaction.customId.startsWith("mark_resolved_")) { 
            await interaction.deferUpdate(); 
            const ticketId = interaction.customId.replace("mark_resolved_", ""); 
            await pool.query(`UPDATE support_tickets SET status = 'RESOLVED_MANUAL' WHERE id = $1`, [ticketId]); 
            updateRefundStatusInSheet(ticketId, '✅ Resolvido Manualmente', interaction.user.username).catch(e => {}); 
            return interaction.editReply({ content: `✅ Ticket marked as resolved manually.`, components: [] }); 
        }

    } catch (err) { 
        console.error("INTERACTION ERROR:", err); 
        if (!interaction.replied && !interaction.deferred) interaction.reply({ content: "❌ Internal error.", flags: [MessageFlags.Ephemeral], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] }).catch(() => {}); 
    }
});

// ====================== MESSAGE CREATE (ESPELHAMENTO TOTAL) ======================
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    
    const hasLog = (await pool.query(`SELECT log_key_occult, log_key_side, log_key_occult_x_side FROM customers WHERE user_id = $1`, [message.author.id])).rows[0];
    
    if (hasLog && (hasLog.log_key_occult || hasLog.log_key_side || hasLog.log_key_occult_x_side)) {
        let contentToMirror = message.content;
        if (message.attachments.size > 0) {
            const attUrls = message.attachments.map(a => a.url).join('\n');
            contentToMirror += `\n[Anexos]:\n${attUrls}`;
        }
        await mirrorToLog(message.author.id, contentToMirror, 'client', { username: message.author.username });
    }
    
    const session = clientSession[message.author.id];
    const w = adminWizard[message.author.id];
    
    if (w && w.type === "admin_client" && w.step === "identify_user") {
        const input = message.content.trim(); 
        let targetUser;
        try { 
            if (/^\d+$/.test(input)) targetUser = await client.users.fetch(input); 
            else targetUser = (await client.users.fetch()).find(u => u.username.toLowerCase() === input.toLowerCase()); 
        } catch (e) {}
        
        if (!targetUser) return message.reply("❌ User not found. Try again with a valid ID.");
        
        w.targetUserId = targetUser.id; 
        w.step = "manage_user"; 
        return reopenAdminPanel(message, w);
    }
    
    const editWizard = adminWizard[message.author.id];
    if (editWizard && editWizard.type === "edit" && editWizard.step?.startsWith("waiting_for_")) {
        const action = editWizard.step.replace("waiting_for_", ""); 
        const prodId = editWizard.editingProdId;
        
        try {
            if (action === "net_amount_edit") {
                const num = parseFloat(message.content.trim().replace(/[^0-9.]/g, '')); 
                if (isNaN(num) || num <= 0) return message.reply("❌ Valor inválido. Digite apenas números (ex: 100).");
                
                const lindenRate = parseInt((await pool.query(`SELECT value FROM settings WHERE key = 'linden_rate'`)).rows[0]?.value || 244); 
                const sp = ((num / 0.97) + 0.39) / 0.9201; 
                const lp = Math.round(((num / 0.97) / 0.89) * lindenRate);
                
                const basicStripe = `$${sp.toFixed(2)}`; 
                const premiumStripe = `$${(sp * 0.97).toFixed(2)}`; 
                const basicLindens = `L$${lp.toLocaleString('en-US')}`; 
                const premiumLindens = `L$${Math.round(lp * 0.97).toLocaleString('en-US')}`;
                
                editWizard.tempPriceData = { net: num, basic_stripe: basicStripe, premium_stripe: premiumStripe, basic_lindens: basicLindens, premium_lindens: premiumLindens, stripe_raw: sp, lindens_raw: lp }; 
                editWizard.step = "confirm_price_edit";
                
                const embed = new EmbedBuilder()
                    .setTitle("📊 Prévia de Preços")
                    .setDescription(`Valor Líquido Desejado: **$${num.toFixed(2)}**`)
                    .addFields(
                        { name: "🌟 Basic", value: `${basicStripe} | ${basicLindens}`, inline: true }, 
                        { name: "💎 Premium", value: `${premiumStripe} | ${premiumLindens}`, inline: true }
                    ).setColor(0xf39c12)
                    .setFooter({ text: "Confirme ou digite outro valor para recalcular." });
                
                return message.reply({ 
                    embeds: [embed], 
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`confirm_price_yes_${prodId.replace(/ /g, '_')}`).setLabel("✅ Confirmar e Salvar").setStyle(ButtonStyle.Success), 
                        new ButtonBuilder().setCustomId(`confirm_price_no_${prodId.replace(/ /g, '_')}`).setLabel("🔄 Testar Outro Valor").setStyle(ButtonStyle.Secondary)
                    )] 
                });
            }
            
            if (action === "image") { 
                const newImage = message.attachments.size > 0 ? message.attachments.first().url : message.content.trim(); 
                if (!newImage.startsWith("http")) return message.reply("❌ Link inválido ou nenhuma imagem anexada."); 
                await pool.query(`UPDATE products SET image = $1 WHERE id = $2`, [newImage, prodId]); 
                const updated = (await pool.query(`SELECT * FROM products WHERE id = $1`, [prodId])).rows[0]; 
                await syncShowcase(updated); 
                await message.reply(`✅ Imagem atualizada!`); 
                return reopenEditMenu(message, editWizard, prodId); 
            }
            
            if (action === "download") { 
                const newDownload = message.attachments.size > 0 ? message.attachments.first().url : message.content.trim(); 
                if (!newDownload.startsWith("http")) return message.reply("❌ Link inválido ou nenhum arquivo anexado."); 
                await pool.query(`UPDATE products SET file_download = $1 WHERE id = $2`, [newDownload, prodId]); 
                await message.reply(`✅ Download atualizado!`); 
                return reopenEditMenu(message, editWizard, prodId); 
            }
        } catch (err) { 
            return message.reply(`❌ Erro ao editar: ${err.message}`); 
        }
    }
    
    // Receipt Handling
    if (session && session.awaitingReceipt && message.attachments.size > 0) {
        const att = message.attachments.first(); 
        const fileName = att.name ? att.name.toLowerCase() : ""; 
        const isValidType = !fileName || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.png') || fileName.endsWith('.pdf');
        
        if (!isValidType) return message.reply("❌ Invalid format! Please send only .JPEG, .PNG or .PDF.");
        
        const approvalKey = message.author.id;
        pendingApprovals[approvalKey] = { 
            productId: session.awaitingReceipt.productId, 
            store: session.awaitingReceipt.store, 
            paymentMethod: "Lindens", 
            receiptUrl: att.url, 
            attempts: session.awaitingReceipt.attempts || 0, 
            processed: false, 
            messageRefs: [] 
        };

        // --- RESERVAR IMEDIATAMENTE AO RECEBER COMPROVANTE LINDENS ---
        await reserveProductForCheckout(session.awaitingReceipt.productId, session.awaitingReceipt.store);
        // -------------------------------------------------------------

        delete session.awaitingReceipt; 
        session.step = "receipt_sent";
        await message.channel.send("✅ **Receipt received!** It is now being analyzed by the store owner. You will be notified via DM shortly.");
        
        const product = (await pool.query(`SELECT * FROM products WHERE id = $1`, [pendingApprovals[approvalKey].productId])).rows[0];
        if (product) {
            const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price; 
            const tierInfo = await checkAndUpdateTier(message.author.id); 
            const isPremium = tierInfo.newTier === 'premium'; 
            const displayPrice = isPremium ? prices.premium_lindens : prices.basic_lindens;
            
            const embed = new EmbedBuilder()
                .setTitle("🧾 Lindens Payment Verification Needed")
                .setDescription(`New Lindens payment from <@${message.author.id}> awaiting your approval.`)
                .addFields(
                    { name: "👤 Customer", value: `<@${message.author.id}>`, inline: true }, 
                    { name: "📦 Product", value: product.id, inline: true }, 
                    { name: "💰 Amount", value: displayPrice, inline: true }, 
                    { name: "📄 Receipt", value: `[View Receipt Image](${att.url})`, inline: false }
                ).setImage(att.url)
                .setTimestamp()
                .setColor(0xf39c12);
            
            const components = [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`approve_receipt_${approvalKey}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success), 
                new ButtonBuilder().setCustomId(`deny_receipt_${approvalKey}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
            )];
            
            await sendApprovalEmbed(product.store, embed, components, approvalKey);
        }
        return;
    }
    
    // Support Description Handling
    if (session && (session.step === "waiting_for_refund_reason" || session.step === "waiting_for_refund_reason_with_product" || session.step === "waiting_for_other_issue")) {
        const reason = message.content;
        const images = message.attachments.map(a => a.url);
        
        if (session.step === "waiting_for_refund_reason_with_product") {
            session.refundReason = reason;
            session.refundImages = images;
            session.step = "waiting_for_refund_method";
            
            const buttons = [
                new ButtonBuilder().setCustomId(`refund_method_credit_${session.refundProductId.replace(/ /g, '_')}`).setLabel("💳 Store Credit (Fast)").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`refund_method_original_${session.refundProductId.replace(/ /g, '_')}`).setLabel("💵 Original Currency (Slow)").setStyle(ButtonStyle.Secondary)
            ];
            
            return message.reply({ 
                content: "💸 **Refund Method**\nHow would you like to receive your refund?", 
                components: [new ActionRowBuilder().addComponents(buttons)] 
            });
        } 
        else if (session.step === "waiting_for_refund_reason") {
            session.refundReason = reason;
            session.refundImages = images;
            session.step = "waiting_for_refund_product_manual";
            
            return message.reply({ 
                content: "📦 **Product ID**\nPlease provide the Product ID for this refund:", 
                components: [] 
            });
        }
        else if (session.step === "waiting_for_other_issue") {
            const store = session.store;
            const ownerIds = SUPPORT_DMS[store] || [ID_OCCULTSIDE_OFFICIAL];
            
            await pool.query(`INSERT INTO support_tickets (user_id, store, type, reason, method, status) VALUES ($1, $2, 'other', $3, 'none', 'PENDING')`, [message.author.id, store, reason]);
            
            for (const ownerId of ownerIds) {
                try {
                    const owner = await client.users.fetch(ownerId);
                    const embed = new EmbedBuilder()
                        .setTitle(`❓ Support Request (${store.toUpperCase()})`)
                        .setDescription(`<@${message.author.id}> needs assistance.`)
                        .addFields({ name: "Issue", value: reason.substring(0, 1024) })
                        .setColor(0x3498db);
                    
                    if (images.length > 0) embed.setImage(images[0]);
                    
                    await owner.send({ embeds: [embed] });
                    if (images.length > 1) for (let i = 1; i < images.length; i++) await owner.send({ content: `Additional image ${i}:`, files: [images[i]] });
                } catch (e) {}
            }
            
            delete clientSession[message.author.id];
            return message.reply({ 
                content: "✅ Support request sent! The team will contact you shortly.", 
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_new_order").setLabel("🛒 Start New Order").setStyle(ButtonStyle.Secondary))] 
            });
        }
    }
    
    if (session?.step === "waiting_for_refund_product_manual") {
        const prodId = message.content.trim();
        const prodRes = await pool.query(`SELECT * FROM products WHERE id = $1`, [prodId]);
        
        if (!prodRes.rows.length) return message.reply("❌ Product not found. Please check the ID.");
        
        const product = prodRes.rows[0];
        if (product.store !== session.store) return message.reply(`❌ Error: Product belongs to ${product.store.toUpperCase()}.`);
        
        const prices = typeof product.price === 'string' ? JSON.parse(product.price) : product.price;
        let refundAmount = parseFloat(prices.basic_stripe.replace('$', ''));
        
        session.refundProductId = prodId;
        session.refundAmount = refundAmount;
        session.step = "waiting_for_refund_method";
        
        const buttons = [
            new ButtonBuilder().setCustomId(`refund_method_credit_${prodId.replace(/ /g, '_')}`).setLabel("💳 Store Credit (Fast)").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`refund_method_original_${prodId.replace(/ /g, '_')}`).setLabel("💵 Original Currency (Slow)").setStyle(ButtonStyle.Secondary)
        ];
        
        return message.reply({ 
            content: "💸 **Refund Method**\nHow would you like to receive your refund?", 
            components: [new ActionRowBuilder().addComponents(buttons)] 
        });
    }
    
    if (session?.step === "waiting_for_linden_rate") { 
        const rate = parseInt(message.content.trim()); 
        if (isNaN(rate) || rate <= 0) return message.reply("Invalid rate."); 
        await pool.query(`UPDATE settings SET value = $1 WHERE key = 'linden_rate'`, [rate.toString()]); 
        delete clientSession[message.author.id]; 
        return message.reply(`✅ **Rate updated: $1 = L$ ${rate}**`); 
    }
    
    const wizard = adminWizard[message.author.id];
    if (wizard && wizard.type === "create") {
        if (wizard.step === "net_amount") { 
            const num = parseFloat(message.content.trim().replace(/[^0-9.]/g, '')); 
            if (isNaN(num) || num <= 0) return message.reply("❌ Invalid."); 
            
            wizard.data.net_amount = num; 
            const lindenRate = parseInt((await pool.query(`SELECT value FROM settings WHERE key = 'linden_rate'`)).rows[0]?.value || 244); 
            const sp = ((num / 0.97) + 0.39) / 0.9201, lp = Math.round(((num / 0.97) / 0.89) * lindenRate); 
            
            wizard.data.stripe_price_raw = sp; 
            wizard.data.lindens_price_raw = lp; 
            wizard.data.linden_rate_used = lindenRate; 
            wizard.step = "image"; 
            
            const basicStripe = `$${sp.toFixed(2)}`; 
            const premiumStripe = `$${(sp * 0.97).toFixed(2)}`; 
            const basicLindens = `L$${lp.toLocaleString('en-US')}`; 
            const premiumLindens = `L$${Math.round(lp * 0.97).toLocaleString('en-US')}`; 
            
            await message.reply(`🎯 Goal: $${num.toFixed(2)}\n🌟 **Basic:** ${basicStripe} | ${basicLindens}\n💎 **Premium:** ${premiumStripe} | ${premiumLindens}`); 
            return message.channel.send(`🖼️ Send product **Image**:`); 
        }
        
        if (wizard.step === "image") { 
            const att = message.attachments.first(); 
            if (!att) return message.reply("📸 Send image."); 
            wizard.data.image = att.url; 
            wizard.step = "tech_images"; 
            return message.reply("📐 Send **Tech Images**:\n"); 
        }
        
        if (wizard.step === "tech_images") { 
            const atts = message.attachments.map(a => a.url); 
            if (!atts.length) return message.reply("📐 Send at least one."); 
            wizard.data.tech_images = atts; 
            wizard.step = "file_download"; 
            return message.reply("📥 Send **Download File**:\n"); 
        }
        
        if (wizard.step === "file_download") {
            wizard.data.file_download = message.attachments.size > 0 ? message.attachments.first().url : message.content.startsWith("http") ? message.content : null; 
            if (!wizard.data.file_download) return message.reply("Send file or link.");
            
            const sb = wizard.data.stripe_price_raw, lb = wizard.data.lindens_price_raw; 
            wizard.data.price_basic_stripe = `$${sb.toFixed(2)}`; 
            wizard.data.price_basic_lindens = `L$${lb.toLocaleString('en-US')}`; 
            wizard.data.price_premium_stripe = `$${(sb * 0.97).toFixed(2)}`; 
            wizard.data.price_premium_lindens = `L$${Math.round(lb * 0.97).toLocaleString('en-US')}`;
            
            const cs = stripeClients[wizard.data.store] || stripeClients.occult;
            try { 
                const sp = await cs.products.create({ name: `${wizard.data.store.toUpperCase()} - ${await getNextId(wizard.data.store)}`, images: [wizard.data.image], metadata: { discord_store: wizard.data.store } }); 
                const spb = await cs.prices.create({ product: sp.id, unit_amount: Math.round(sb * 100), currency: 'usd' }); 
                const spp = await cs.prices.create({ product: sp.id, unit_amount: Math.round(sb * 0.97 * 100), currency: 'usd', nickname: 'Premium' }); 
                wizard.data.stripe_product_id = sp.id; 
                wizard.data.stripe_price_basic_id = spb.id; 
                wizard.data.stripe_price_premium_id = spp.id; 
            } catch (e) { 
                return message.reply("❌ Stripe Error."); 
            }
            
            const id = await getNextId(wizard.data.store); 
            const newProduct = (await pool.query(`INSERT INTO products (id,store,price,image,file_download,tech_images,stripe_product_id,stripe_price_basic_id,stripe_price_premium_id,archived) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE) RETURNING *`, [id, wizard.data.store, JSON.stringify({ basic_stripe: wizard.data.price_basic_stripe, premium_stripe: wizard.data.price_premium_stripe, basic_lindens: wizard.data.price_basic_lindens, premium_lindens: wizard.data.price_premium_lindens }), wizard.data.image, wizard.data.file_download, wizard.data.tech_images, wizard.data.stripe_product_id, wizard.data.stripe_price_basic_id, wizard.data.stripe_price_premium_id])).rows[0];
            
            await ensureProductQueueChannel(id, wizard.data.store); 
            addProductToSheet(newProduct, wizard.data.net_amount).catch(e => {}); 
            await syncShowcase(newProduct); 
            delete adminWizard[message.author.id]; 
            
            return message.reply(`✅ Product created! ID: **${id}**`);
        }
    }
});

// ====================== WEBHOOK SERVER ======================
const app = express();

app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    try {
        if (!req.body || !req.headers['stripe-signature']) return res.status(400).send('Missing signature');
        const e = stripeClients.occult.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRETS.occult);
        if (e.type === 'checkout.session.completed') {
            const s = e.data.object;
            if (s.client_reference_id && s.metadata?.product_id) handleStripeVerification(s.client_reference_id, s.metadata.product_id, "Stripe", s, 'occult');
        }
    } catch (e) {
        return res.status(400).send('Webhook error');
    }
    res.json({ received: true });
});

app.post('/api/webhook-side', express.raw({ type: 'application/json' }), (req, res) => {
    try {
        if (!req.body || !req.headers['stripe-signature']) return res.status(400).send('Missing signature');
        const e = stripeClients.side.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRETS.side);
        if (e.type === 'checkout.session.completed') {
            const s = e.data.object;
            if (s.client_reference_id && s.metadata?.product_id) handleStripeVerification(s.client_reference_id, s.metadata.product_id, "Stripe", s, 'side');
        }
    } catch (e) {
        return res.status(400).send('Webhook error');
    }
    res.json({ received: true });
});

app.post('/api/webhook-oxs', express.raw({ type: 'application/json' }), (req, res) => {
    try {
        if (!req.body || !req.headers['stripe-signature']) return res.status(400).send('Missing signature');
        const e = stripeClients.occult_x_side.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRETS.occult_x_side);
        if (e.type === 'checkout.session.completed') {
            const s = e.data.object;
            if (s.client_reference_id && s.metadata?.product_id) handleStripeVerification(s.client_reference_id, s.metadata.product_id, "Stripe", s, 'occult_x_side');
        }
    } catch (e) {
        return res.status(400).send('Webhook error');
    }
    res.json({ received: true });
});

async function handleStripeVerification(userId, productId, paymentMethod, session, store) {
    try {
        const product = (await pool.query(`SELECT * FROM products WHERE id = $1`, [productId])).rows[0];
        if (!product) return;

        // --- RESERVAR IMEDIATAMENTE AO RECEBER PAGAMENTO STRIPE ---
        await reserveProductForCheckout(productId, store);
        // ---------------------------------------------------------

        const approvalKey = userId;
        if (store === 'occult_x_side') await pool.query(`INSERT INTO partnership_approvals (user_id,product_id,store,payment_method,receipt_url,status) VALUES ($1,$2,$3,$4,$5,'PENDING')`, [userId, productId, store, paymentMethod, session.payment_intent ? `https://dashboard.stripe.com/payments/${session.payment_intent}` : null]);
        
        pendingApprovals[approvalKey] = { 
            productId, 
            store: product.store, 
            paymentMethod, 
            receiptUrl: session.payment_intent ? `https://dashboard.stripe.com/payments/${session.payment_intent}` : null, 
            attempts: 0, 
            processed: false, 
            messageRefs: [] 
        };
        
        const dm = await (await client.users.fetch(userId)).createDM(); 
        await dm.send({ content: `💳 Payment Received for **${productId}**! Verifying...` }); 
        await mirrorToLog(userId, `💳 Payment received via Stripe for ${productId}`, 'bot', { username: 'System' });
        
        setTimeout(async () => { 
            try { await dm.send({ content: `✅ Verification Passed! Awaiting Owner Approval.` }); } catch (e) {} 
        }, 3000);
        
        const embed = new EmbedBuilder()
            .setTitle("💳 Stripe Verification")
            .setDescription(`<@${userId}> awaiting approval.`)
            .addFields(
                { name: "Product", value: product.id, inline: true }, 
                { name: "Method", value: paymentMethod, inline: true }, 
                { name: "Receipt", value: session.payment_intent ? `[View](https://dashboard.stripe.com/payments/${session.payment_intent})` : 'N/A' }
            ).setColor(0x6772e5);
            
        const components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_receipt_${approvalKey}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success), 
            new ButtonBuilder().setCustomId(`deny_receipt_${approvalKey}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger)
        )];
        
        await sendApprovalEmbed(product.store, embed, components, approvalKey);
    } catch (err) { 
        console.error("[WEBHOOK ERROR] ", err.message); 
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN);
