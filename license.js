const { EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// ====================== HELPERS INTERNOS ======================
const usd = v => parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')) || 0;
const ldn = v => parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0;
const parse = p => { try { return (typeof p === 'string' ? JSON.parse(p) : p) || {}; } catch { return {}; } };
const btn = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const fmtL = n => `L$${Math.round(n).toLocaleString('en-US')}`;
const fmtU = n => `$${n.toFixed(2)}`;

const METHOD_META = {
    stripe: { emoji: '💳', label: 'STRIPE', name: 'Stripe' },
    lindens: { emoji: '💎', label: 'LINDENS', name: 'Lindens' },
    paypal: { emoji: '🅿️', label: 'PAYPAL', name: 'PayPal' },
    wise: { emoji: '💵', label: 'WISE', name: 'Wise' }
};

// ====================== DESCONTO / COMPATIBILIDADE ======================
function discountFromLicenseType(product) {
    const m = String(product?.license_type || '').match(/-(\d+(?:\.\d+)?)%/);
    return m ? parseFloat(m[1]) : null;
}

function discountFromPrices(exclusive, shared) {
    const e = exclusive.raw_stripe || usd(exclusive.basic_stripe);
    const s = shared.raw_stripe || usd(shared.basic_stripe);
    if (e > 0 && s > 0 && s < e) return Math.round((1 - s / e) * 100);
    return null;
}

// Aplica o desconto da Shared sobre o preço base (Exclusive)
function applySharedDiscount(base, discountPercent) {
    const m = 1 - (discountPercent / 100);
    const rs = (base.raw_stripe ?? usd(base.basic_stripe)) * m;
    const rl = Math.round((base.raw_lindens ?? ldn(base.basic_lindens)) * m);
    const rp = (base.raw_paypal ?? usd(base.basic_paypal)) * m;
    const rw = (base.raw_wise ?? usd(base.basic_wise)) * m;
    return {
        basic_stripe: fmtU(rs), premium_stripe: fmtU(rs * 0.97),
        basic_lindens: fmtL(rl), premium_lindens: fmtL(rl * 0.97),
        basic_paypal: fmtU(rp), premium_paypal: fmtU(rp * 0.97),
        basic_wise: fmtU(rw), premium_wise: fmtU(rw * 0.97),
        raw_stripe: rs, raw_lindens: rl, raw_paypal: rp, raw_wise: rw
    };
}

// NOVO esquema: price = Exclusive (base) | price_shared = Shared (desconto)
// LEGADO: price = Shared | price_exclusive = Exclusive (+20% antigo) → ainda funciona
function getProductPrices(product) {
    const base = parse(product.price);
    if (product.price_shared) {
        const shared = parse(product.price_shared);
        if (shared.basic_stripe) {
            const d = discountFromLicenseType(product) ?? discountFromPrices(base, shared) ?? 20;
            return { exclusive: base, shared, discountPercent: d };
        }
    }
    if (product.price_exclusive) {
        const ex = parse(product.price_exclusive);
        if (ex.basic_stripe) {
            const d = discountFromPrices(ex, base) ?? 20;
            return { exclusive: ex, shared: base, discountPercent: d };
        }
    }
    const d = discountFromLicenseType(product) ?? 20;
    return { exclusive: base, shared: applySharedDiscount(base, d), discountPercent: d };
}

// ====================== CALCULADORA (NOVA LÓGICA) ======================
// Exclusive = preço base (gross-up para você receber netAmount líquido)
// Shared = base - desconto% (você recebe menos, o cliente paga menos)
async function calculateLicensePrices(netAmount, sharedDiscountPercent, pool, getLindenRate) {
    const discount = Math.min(90, Math.max(0, parseFloat(sharedDiscountPercent) || 20));
    const feesRes = await pool.query(`SELECT method, percent_fee, fixed_fee FROM payment_fees`);
    const f = {};
    feesRes.rows.forEach(r => f[r.method] = { pct: parseFloat(r.percent_fee) || 0, fixed: parseFloat(r.fixed_fee) || 0 });

    let lindenRate = 244;
    try { const rate = await getLindenRate(); if (rate) lindenRate = rate; } catch (e) { }

    const stripePct = f['stripe']?.pct || 0, stripeFixed = f['stripe']?.fixed || 0;
    const paypalPct = f['paypal']?.pct || 0, paypalFixed = f['paypal']?.fixed || 0;
    const wisePct = f['wise']?.pct || 0, wiseFixed = f['wise']?.fixed || 0;
    const lindensPct = f['lindens']?.pct || 11, lindensFixed = f['lindens']?.fixed || 0;

    // 1) EXCLUSIVE (base): valor bruto necessário para o líquido desejado
    let exStripe = ((netAmount / 0.97) + 0.39) / 0.9201;
    exStripe = (exStripe * (1 + stripePct / 100)) + stripeFixed;
    let exLinden = Math.round(((netAmount / 0.97) / (1 - (lindensPct / 100))) * lindenRate);
    exLinden = Math.round(exLinden + (lindensFixed * lindenRate));
    const exPaypal = (exStripe * (1 + paypalPct / 100)) + paypalFixed;
    const exWise = (exStripe * (1 + wisePct / 100)) + wiseFixed;

    const exclusive = {
        basic_stripe: fmtU(exStripe), premium_stripe: fmtU(exStripe * 0.97),
        basic_lindens: fmtL(exLinden), premium_lindens: fmtL(exLinden * 0.97),
        basic_paypal: fmtU(exPaypal), premium_paypal: fmtU(exPaypal * 0.97),
        basic_wise: fmtU(exWise), premium_wise: fmtU(exWise * 0.97),
        raw_stripe: exStripe, raw_lindens: exLinden, raw_paypal: exPaypal, raw_wise: exWise
    };

    // 2) SHARED: desconto aplicado sobre a base
    const shared = applySharedDiscount(exclusive, discount);
    return { exclusive, shared, discountPercent: discount };
}

// Estimativa de líquido para o preview do admin (taxas majoritariamente proporcionais)
function estimateNet(netAmount, discountPercent, premium = false) {
    return netAmount * (1 - discountPercent / 100) * (premium ? 0.97 : 1);
}

// ====================== FORMATAÇÃO / UI ======================
function getLicensePricesForTier(prices, isPremium) {
    return {
        stripe: isPremium ? prices.premium_stripe : prices.basic_stripe,
        lindens: isPremium ? prices.premium_lindens : prices.basic_lindens,
        paypal: isPremium ? prices.premium_paypal : prices.basic_paypal,
        wise: isPremium ? prices.premium_wise : prices.basic_wise,
        rawStripe: isPremium ? usd(prices.premium_stripe) : usd(prices.basic_stripe),
        rawLindens: isPremium ? ldn(prices.premium_lindens) : ldn(prices.basic_lindens),
        rawPaypal: isPremium ? usd(prices.premium_paypal) : usd(prices.basic_paypal),
        rawWise: isPremium ? usd(prices.premium_wise) : usd(prices.basic_wise)
    };
}

// Preview: apenas Stripe + Lindens (vitrine, produto, escolha de licença)
function priceLine(prices, enabled, premium = false) {
    const tier = premium ? 'premium' : 'basic';
    const p = [];
    if (enabled.includes('stripe')) p.push(`💳 ${prices[`${tier}_stripe`]}`);
    if (enabled.includes('lindens')) p.push(`💎 ${prices[`${tier}_lindens`]}`);
    if (!p.length) enabled.slice(0, 2).forEach(m => p.push(`${METHOD_META[m].emoji} ${prices[`${tier}_${m}`]}`));
    return p.join('  •  ') || 'No payment methods enabled';
}

// YOUR PRICE — USD ordenado do menor para o maior à esquerda, Lindens à direita
function buildPriceFields(prices, enabled) {
    const usdList = [
        { k: 'stripe', v: prices.stripe, raw: prices.rawStripe },
        { k: 'paypal', v: prices.paypal, raw: prices.rawPaypal },
        { k: 'wise', v: prices.wise, raw: prices.rawWise }
    ].filter(o => enabled.includes(o.k)).sort((a, b) => a.raw - b.raw);
    const left = usdList.map(o => `${METHOD_META[o.k].emoji} **${METHOD_META[o.k].label}**: ${o.v}`).join('\n');
    const hasLindens = enabled.includes('lindens');
    if (hasLindens && left) return [
        { name: '**YOUR PRICE**', value: left, inline: true },
        { name: '\u200b', value: `💎 **LINDENS**: ${prices.lindens}`, inline: true }
    ];
    if (hasLindens) return [{ name: '**YOUR PRICE**', value: `💎 **LINDENS**: ${prices.lindens}`, inline: false }];
    if (left) return [{ name: '**YOUR PRICE**', value: left, inline: false }];
    return [{ name: '**YOUR PRICE**', value: '⚠️ No payment methods enabled for this store.', inline: false }];
}

function paymentButtons(enabled, prices) {
    const usdList = [
        { k: 'stripe', raw: prices.rawStripe }, { k: 'paypal', raw: prices.rawPaypal }, { k: 'wise', raw: prices.rawWise }
    ].filter(o => enabled.includes(o.k)).sort((a, b) => a.raw - b.raw);
    const order = [...usdList.map(o => o.k)];
    if (enabled.includes('lindens')) order.push('lindens');
    const styles = { stripe: ButtonStyle.Success, lindens: ButtonStyle.Primary, paypal: ButtonStyle.Secondary, wise: ButtonStyle.Secondary };
    return order.map(k => btn(`pay_${k}`, `${METHOD_META[k].emoji} Pay with ${METHOD_META[k].name}`, styles[k]));
}

// ====================== EMBEDS ======================
// Resumo do admin: preços + QUANTO VOCÊ RECEBE LÍQUIDO em cada licença
function buildAdminPriceSummary(netAmount, prices) {
    const d = prices.discountPercent;
    return new EmbedBuilder()
        .setTitle('📊 License Pricing & Your Net Profit')
        .setDescription(`Target net amount (Exclusive): **US$ ${netAmount.toFixed(2)}**\nChoose the **Shared discount** below:`)
        .addFields(
            {
                name: '📜 EXCLUSIVE LICENSE (Base — full price)',
                value: `🌟 Basic: ${prices.exclusive.basic_stripe} | ${prices.exclusive.basic_lindens}\n💎 Premium: ${prices.exclusive.premium_stripe} | ${prices.exclusive.premium_lindens}\n💰 **You receive: ~US$ ${netAmount.toFixed(2)}** (Basic) / ~US$ ${(netAmount * 0.97).toFixed(2)} (Premium)`,
                inline: false
            },
            {
                name: `📄 SHARED LICENSE (-${d}% OFF)`,
                value: `🌟 Basic: ${prices.shared.basic_stripe} | ${prices.shared.basic_lindens}\n💎 Premium: ${prices.shared.premium_stripe} | ${prices.shared.premium_lindens}\n💰 **You receive: ~US$ ${estimateNet(netAmount, d).toFixed(2)}** (Basic) / ~US$ ${estimateNet(netAmount, d, true).toFixed(2)} (Premium)`,
                inline: false
            }
        )
        .setColor(0x3498db)
        .setFooter({ text: 'Database base price (price) = Exclusive • Net values are estimates after fees' });
}

function buildLicenseSelectionEmbed(product, isPremium, enabled) {
    const { exclusive, shared, discountPercent } = getProductPrices(product);
    const ex = getLicensePricesForTier(exclusive, isPremium);
    const sh = getLicensePricesForTier(shared, isPremium);
    const line = p => {
        const out = [];
        if (enabled.includes('stripe')) out.push(`💳 ${p.stripe}`);
        if (enabled.includes('lindens')) out.push(`💎 ${p.lindens}`);
        if (!out.length) enabled.slice(0, 2).forEach(m => out.push(`${METHOD_META[m].emoji} ${p[m]}`));
        return out.join(' / ');
    };
    return new EmbedBuilder().setTitle('CHOOSE YOUR LICENSE').setColor(isPremium ? 0xFFD700 : 0x3498db)
        .addFields(
            { name: `\u200b\n📜 EXCLUSIVE LICENSE — ${line(ex)}`, value: `• **You:** Exclusive commercial rights.\n• **Occultside:** No commercial use on any platform.\n\u200b`, inline: false },
            { name: `\u200b\n📄 SHARED LICENSE — ${line(sh)} (${discountPercent}% OFF)`, value: `• **You:** Sell on Second Life.\n• **Occultside:** May adapt and sell on other platforms, but never as a Premade.\n\u200b`, inline: false }
        ).setFooter({ text: 'OCCULTSIDE • COMMERCIAL LICENSING' });
}

function getLicenseTexts(chosenLicense) {
    const isShared = chosenLicense === 'Shared';
    return {
        isShared,
        licenseName: isShared ? 'Shared License' : 'Exclusive License',
        includesText: isShared
            ? 'Exclusive access to the original mesh.\nCommercial rights to sell the product in Second Life.\nOccultside may sell its own adaptations on other platforms.'
            : 'Exclusive access to the original mesh.\nComplete commercial exclusivity for the design.\nOccultside relinquishes all commercial rights.',
        cannotText: isShared
            ? 'Occultside cannot sell the original Premade anywhere.\nThe original mesh will never be resold or distributed.'
            : 'Occultside cannot use, adapt or commercialize the design anywhere.\nThe original mesh will never be resold or distributed.'
    };
}

function buildLicenseConfirmationEmbed(product, chosenLicense, isPremium, enabled) {
    const gp = getProductPrices(product);
    const activePrices = chosenLicense === 'Shared' ? gp.shared : gp.exclusive;
    const prices = getLicensePricesForTier(activePrices, isPremium);
    const { isShared, licenseName, includesText, cannotText } = getLicenseTexts(chosenLicense);
    return new EmbedBuilder()
        .setTitle(`${isShared ? '📄' : '📜'} ${licenseName}`)
        .setDescription(`You have selected the **${licenseName}** for this product.${isShared ? `\n*(${gp.discountPercent}% discount applied to the Exclusive base price)*` : ''}`)
        .setColor(isPremium ? 0xFFD700 : 0x2ecc71)
        .addFields(
            { name: '📦 **Your purchase includes:**', value: includesText, inline: false },
            { name: '**🚫 Restrictions:**', value: cannotText, inline: false },
            ...buildPriceFields(prices, enabled)
        ).setFooter({ text: 'Do you agree to these conditions?' });
}

module.exports = {
    METHOD_META,
    calculateLicensePrices,
    applySharedDiscount,
    getProductPrices,
    getLicensePricesForTier,
    priceLine,
    buildPriceFields,
    paymentButtons,
    buildAdminPriceSummary,
    buildLicenseSelectionEmbed,
    buildLicenseConfirmationEmbed,
    getLicenseTexts
};
