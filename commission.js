// ==============================================================================
// === MÓDULO DE COMISSÕES + SUGGESTIONS ========================================
// Carregado automaticamente pelo index.js
// ==============================================================================
module.exports = function initCommission(ctx) {

    const {
        client, pool, adminWizard, clientSession,
        ADMIN_ROLE_ID, DEV_IDS, MessageFlags,
        formatBrasiliaDate, resetSessionTimer
    } = ctx;

    const {
        Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
        ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder
    } = require('discord.js');

    const EP = { flags: [MessageFlags.Ephemeral] };

    // ==========================================================================
    // === CONFIGURAÇÕES (EDITE AQUI) ===========================================
    // ==========================================================================

    // Quem recebe as comissões por DM (pode colocar quantos IDs quiser por loja)
    const COMMISSION_DMS = {
        occult: ["721614093269729292", "1543019733949874187"],
        side: ["721614093269729292", "1543019733949874187"],
        occult_x_side: ["721614093269729292", "1543019733949874187"]
    };

    // ⚠️ TROQUE OS IDs ABAIXO pelos IDs reais das contas de comissão de cada loja
    const COMMISSION_CONTACTS = {
        occult: { id: "721614093269729292", username: "𝐎𝐂𝐂𝐔𝐋𝐓  |  COMMISSIONS" },
        side: { id: "971051392456331324", username: "𝐒𝐈𝐃𝐄︱𝐂𝐎𝐌𝐌𝐈𝐒𝐒𝐈𝐎𝐍𝐒" },
        occult_x_side: { id: "1356140129865175221", username: "𝐎𝐂𝐂𝐔𝐋𝐓𝐒𝐈𝐃𝐄 | COMMISSIONS" }
    };

    // Canal de log das comissões (opcional). Vazio = usa o sistema de log do index
    const COMMISSION_LOG_CHANNEL_ID = "";

    // Suggestions
    const SUGGESTIONS_PANEL_CHANNEL_ID = "1566992317502718104";
    const OUTFIT_IDEAS_CHANNEL_ID = "1566992867283705967";
    const MAX_SUGGESTION_IMAGES = 10;

    const COMMISSION_PATTERNS = ['Poá', 'Listras', 'Xadrez', 'Animal print', 'Floral', 'Geométricas'];
    const TRANSFER_DEADLINE_HOURS = 24;
    const STORES = ['occult', 'side', 'occult_x_side'];

    // ==========================================================================
    // === HELPERS ==============================================================
    // ==========================================================================
    const btn = (id, label, style = ButtonStyle.Secondary) =>
        new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
    const row = (...b) => new ActionRowBuilder().addComponents(b);
    const cut = (s, n = 1024) => String(s ?? '').substring(0, n);

    const storeLabel = s => s === 'occult_x_side' ? 'Occult x Side' : (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
    const payLabel = m => ({ stripe: '💳 Stripe', lindens: '💎 Lindens', paypal: '🅿️ PayPal', wise: '💵 Wise' }[m] || m || 'N/A');
    const typeLabel = t => ({ solid_colors: 'Solid Colors', prints_with_ref: 'Prints with Reference', prints_without_ref: 'Prints without Reference' }[t] || t || 'N/A');
    const reasonLabel = t => ({ busy: '⏰ No time available', complex: '🔧 Mesh too complex', custom: '✏️ Other reason' }[t] || t || 'Not informed');

    function reasonText(type, custom) {
        if (type === 'complex') return "The requested mesh is too complex for our current production capacity.";
        if (type === 'busy') return "We currently don't have the time availability to complete this commission within the desired deadline.";
        return custom || "Not specified.";
    }

    function refLinks(arr) {
        if (!arr || !arr.length) return 'None';
        return arr.map((u, i) => `[Image ${i + 1}](${u})`).join(' • ');
    }

    function chunkButtons(buttons, perRow = 5) {
        const rows = [];
        let cur = new ActionRowBuilder();
        for (const b of buttons) {
            if (cur.components.length === perRow) { rows.push(cur); cur = new ActionRowBuilder(); }
            cur.addComponents(b);
        }
        if (cur.components.length) rows.push(cur);
        return rows.slice(0, 5);
    }

    async function isAdmin(interaction) {
        if (DEV_IDS.includes(interaction.user.id)) return true;
        if (!interaction.guild) return false;
        if (interaction.guild.ownerId === interaction.user.id) return true;
        try {
            const m = await interaction.guild.members.fetch(interaction.user.id);
            return m.roles.cache.has(ADMIN_ROLE_ID);
        } catch { return false; }
    }

    // ==========================================================================
    // === LOG ==================================================================
    // ==========================================================================
    async function logCommission(userId, text, extra = {}) {
        try {
            if (COMMISSION_LOG_CHANNEL_ID) {
                const ch = await client.channels.fetch(COMMISSION_LOG_CHANNEL_ID).catch(() => null);
                if (ch) {
                    const e = new EmbedBuilder()
                        .setDescription(`🎨 **COMMISSION LOG**\n${text}`)
                        .addFields({ name: 'Client', value: `<@${userId}> (\`${userId}\`)`, inline: false })
                        .setColor(0x9b59b6).setTimestamp();
                    if (extra.requestId) e.addFields({ name: 'Request', value: `\`${extra.requestId}\``, inline: true });
                    if (extra.store) e.addFields({ name: 'Store', value: storeLabel(extra.store), inline: true });
                    await ch.send({ embeds: [e] }).catch(() => { });
                }
            }
            if (typeof ctx.mirrorToLog === 'function') {
                await ctx.mirrorToLog(userId, `[COMMISSION] ${text}`, 'bot', { username: extra.username || 'Client', store: extra.store });
            }
            console.log(`[COMMISSION] ${userId} :: ${text}`);
        } catch (e) { /* silent */ }
    }

    // ==========================================================================
    // === NUMERAÇÃO PERMANENTE =================================================
    // ==========================================================================
    async function nextCommissionId(store) {
        const prefix = store === 'occult' ? 'OCC' : store === 'side' ? 'SID' : 'OXS';
        const r = await pool.query(
            `INSERT INTO commission_counters (store, last_number) VALUES ($1, 1)
             ON CONFLICT (store) DO UPDATE SET last_number = commission_counters.last_number + 1
             RETURNING last_number`, [store]);
        return `${prefix}-C${String(r.rows[0].last_number).padStart(3, '0')}`;
    }

    async function freeSlot(store) {
        await pool.query(`UPDATE commission_configs SET available_slots = available_slots + 1, clients_in_progress = GREATEST(0, clients_in_progress - 1), updated_at = NOW() WHERE store = $1`, [store]);
    }
    async function takeSlot(store) {
        await pool.query(`UPDATE commission_configs SET available_slots = GREATEST(0, available_slots - 1), clients_in_progress = clients_in_progress + 1, updated_at = NOW() WHERE store = $1`, [store]);
    }

    async function archiveCommission(comm, deletedBy, reason) {
        try {
            await pool.query(
                `INSERT INTO commission_history (request_id, user_id, store, status, payload, deleted_by, deleted_reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [comm.request_id, comm.user_id, comm.store, comm.status, JSON.stringify(comm), deletedBy, reason]);
        } catch (e) { console.error('archive error:', e.message); }
    }

    // ==========================================================================
    // === ENVIO / NOTIFICAÇÃO ==================================================
    // ==========================================================================
    async function sendCommissionToStore(store, embeds, components) {
        const ids = COMMISSION_DMS[store] || [];
        let first = null;
        for (const id of ids) {
            try {
                const u = await client.users.fetch(id);
                const msg = await u.send({ embeds, components });
                if (!first) first = msg;
            } catch (e) { console.error(`DM commission fail ${id}:`, e.message); }
        }
        return first;
    }

    async function dmUser(userId, payload) {
        try {
            const u = await client.users.fetch(userId);
            return await u.send(payload);
        } catch (e) { return null; }
    }

    function backToStoreRow() {
        return row(btn('comm_back_store', '🛒 Back to Store', ButtonStyle.Secondary));
    }

    // ==========================================================================
    // === EMBEDS DA COMISSÃO ===================================================
    // ==========================================================================
    function commissionEmbed(comm, user, title) {
        const uname = user ? user.username : comm.user_id;
        const e = new EmbedBuilder()
            .setTitle(title || `🎨 Commission ${comm.request_id}`)
            .setDescription(
                `Request ID: \`${comm.request_id}\`\n` +
                `Client: <@${comm.user_id}> (${uname})\n` +
                `Client ID: \`${comm.user_id}\`\n` +
                `Store: \`${storeLabel(comm.store)}\`\n` +
                `Status: \`${comm.status}\`\n` +
                `Created: \`${comm.created_at ? formatBrasiliaDate(new Date(comm.created_at)) : 'N/A'}\``
            )
            .setColor(0x9b59b6).setTimestamp();

        e.addFields({
            name: '📐 Mesh',
            value: cut(
                `• Quantity: \`${comm.mesh_quantity}\`\n` +
                `• Description: ${comm.mesh_description || 'N/A'}\n` +
                `• Changes: ${comm.mesh_changes || 'As provided'}\n` +
                `• Rigging: ${comm.rigging_confirmed ? '✅ Acknowledged' : '❌ Not confirmed'}\n` +
                `• References: ${refLinks(comm.mesh_references)}`
            ), inline: false
        });

        e.addFields({ name: '💳 Payment', value: payLabel(comm.payment_method), inline: true });

        if (comm.texturization_requested) {
            let t = `• Type: ${typeLabel(comm.texturization_type)}\n• Quantity: \`${comm.texturization_quantity}\`\n`;
            if (comm.selected_patterns?.length) t += `• Patterns: ${comm.selected_patterns.join(', ')}\n`;
            if (comm.selected_colors?.length) t += `• Colors: ${comm.selected_colors.join(', ')}\n`;
            t += `• References: ${refLinks(comm.print_references)}`;
            e.addFields({ name: '🎨 Texturization', value: cut(t), inline: false });
        } else {
            e.addFields({ name: '🎨 Texturization', value: 'Not requested', inline: false });
        }

        if (comm.transfer_from_store) {
            e.addFields({
                name: '🔁 Transfer history',
                value: cut(`Originally \`${comm.transfer_from_request_id}\` at \`${storeLabel(comm.transfer_from_store)}\`.\nReason: ${reasonText(comm.transfer_reason_type, comm.transfer_reason_text)}`),
                inline: false
            });
        }

        const all = [...(comm.mesh_references || []), ...(comm.print_references || [])];
        if (all.length) e.setImage(all[0]);
        return e;
    }

    function adminActionRows(requestId) {
        return [
            row(
                btn(`admin_commission_accept_${requestId}`, '✅ Accept', ButtonStyle.Success),
                btn(`admin_commission_decline_${requestId}`, '❌ Decline', ButtonStyle.Danger),
                btn(`admin_commission_transfer_${requestId}`, '🔁 Transfer', ButtonStyle.Primary)
            ),
            row(btn(`admin_commission_details_${requestId}`, '🔍 View full details', ButtonStyle.Secondary))
        ];
    }

    function paymentPayload() {
        return {
            embeds: [new EmbedBuilder()
                .setTitle('💳 Final Step — Payment Method')
                .setDescription('How would you like to pay for this commission?\n\n⚠️ Store credits **cannot** be used for commissions.')
                .setColor(0x3498db)
                .setFooter({ text: 'Click one of the options below' })],
            components: [row(
                btn('comm_pay_stripe', '💳 Stripe', ButtonStyle.Primary),
                btn('comm_pay_lindens', '💎 Lindens', ButtonStyle.Primary),
                btn('comm_pay_paypal', '🅿️ PayPal', ButtonStyle.Primary),
                btn('comm_pay_wise', '💵 Wise', ButtonStyle.Primary)
            )]
        };
    }

    function reviewPayload(c) {
        let d = `Store: \`${storeLabel(c.store)}\`\n━━━━━━━━━━━━━━━━━━━━\n`;
        d += `📐 **Mesh**\n• Quantity: ${c.mesh_quantity}\n• Description: ${c.mesh_description || 'N/A'}\n• Changes: ${c.mesh_changes || 'As provided'}\n`;
        d += `• References: ${c.mesh_references?.length || 0} image(s)\n• Rigging: ${c.rigging_confirmed ? '✅ Acknowledged' : '❌'}\n`;
        d += `━━━━━━━━━━━━━━━━━━━━\n💳 Payment: ${payLabel(c.payment_method)}\n━━━━━━━━━━━━━━━━━━━━\n`;
        if (c.texturization_requested) {
            d += `🎨 **Texturization:** Yes\n• Type: ${typeLabel(c.texturization_type)}\n• Quantity: ${c.texturization_quantity}\n`;
            if (c.selected_patterns?.length) d += `• Patterns: ${c.selected_patterns.join(', ')}\n`;
            if (c.selected_colors?.length) d += `• Colors: ${c.selected_colors.join(', ')}\n`;
            d += `• References: ${c.print_references?.length || 0} image(s)\n`;
        } else d += `🎨 **Texturization:** No\n`;

        return {
            embeds: [new EmbedBuilder()
                .setTitle('📋 Review Your Commission')
                .setDescription(cut(d, 4096))
                .setColor(0x9b59b6)
                .setFooter({ text: 'Everything you sent will be delivered to the store.' })],
            components: [row(
                btn('comm_submit', '✅ Submit request', ButtonStyle.Success),
                btn('comm_cancel', '❌ Cancel request', ButtonStyle.Danger)
            )]
        };
    }

    function riggingPayload() {
        return {
            embeds: [new EmbedBuilder()
                .setTitle('⚠️ Important — Rigging')
                .setDescription('**Rigging is NOT included** in commissions.\nDo you acknowledge and want to continue?')
                .setColor(0xf1c40f)],
            components: [row(
                btn('comm_rig_yes', '✅ I understand, continue', ButtonStyle.Success),
                btn('comm_rig_no', '❌ Cancel', ButtonStyle.Danger)
            )]
        };
    }

    function texturizationPayload() {
        return {
            embeds: [new EmbedBuilder()
                .setTitle('🎨 Texturization')
                .setDescription('Do you want to include texturization in this commission?')
                .setColor(0x3498db)],
            components: [row(
                btn('comm_text_yes', '✅ Yes, I want texturization', ButtonStyle.Success),
                btn('comm_text_no', '❌ No, mesh only', ButtonStyle.Secondary)
            )]
        };
    }

    function refsPayload(kind) {
        const dmId = kind === 'mesh' ? 'comm_refs_dm' : 'comm_printrefs_dm';
        const skipId = kind === 'mesh' ? 'comm_refs_skip' : 'comm_printrefs_skip';
        return {
            embeds: [new EmbedBuilder()
                .setTitle(kind === 'mesh' ? '🖼️ Mesh Reference Images' : '🖼️ Print Reference Images')
                .setDescription('To keep your privacy, images are sent in a **private DM** with the bot.\nNothing will appear in the server channel.')
                .setColor(0x3498db)],
            components: [row(
                btn(dmId, '📩 Send images in DM', ButtonStyle.Primary),
                btn(skipId, '⏭️ Skip / No images', ButtonStyle.Secondary)
            )]
        };
    }

    // ==========================================================================
    // === DECLÍNIO =============================================================
    // ==========================================================================
    async function processCommissionDecline(requestId, declineType, declineReason, adminId) {
        const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id = $1`, [requestId])).rows[0];
        if (!comm || comm.status === 'DECLINED') return null;

        await pool.query(
            `UPDATE active_commissions SET status='DECLINED', decline_type=$1, decline_reason=$2, reviewed_by=$3, transfer_status=NULL, updated_at=NOW() WHERE request_id=$4`,
            [declineType, declineReason, adminId, requestId]);
        await freeSlot(comm.store);

        const e = new EmbedBuilder()
            .setTitle('❌ Commission Declined')
            .setDescription(`Unfortunately, your commission \`${requestId}\` could not be accepted.`)
            .addFields({ name: '📝 Reason', value: reasonText(declineType, declineReason) })
            .setColor(0xe74c3c).setTimestamp();
        await dmUser(comm.user_id, { embeds: [e], components: [backToStoreRow()] });

        await logCommission(comm.user_id, `Commission ${requestId} DECLINED (${declineType})`, { requestId, store: comm.store });
        return comm;
    }

    // ==========================================================================
    // === PAINEL ADMIN =========================================================
    // ==========================================================================
    async function showCommissionPanel(interaction, store) {
        const config = (await pool.query(`SELECT * FROM commission_configs WHERE store=$1`, [store])).rows[0]
            || { status: 'CLOSED', total_slots: 0, available_slots: 0, clients_in_progress: 0 };

        const e = new EmbedBuilder()
            .setTitle(`📋 COMMISSION PANEL — ${storeLabel(store)}`)
            .setDescription('Manage availability, requests and clients of this store.')
            .addFields(
                { name: 'Status', value: config.status === 'OPEN' ? '🟢 Open' : '🔴 Closed', inline: true },
                { name: 'Available Slots', value: `${config.available_slots}/${config.total_slots}`, inline: true },
                { name: 'In Progress', value: `${config.clients_in_progress}`, inline: true }
            )
            .setColor(config.status === 'OPEN' ? 0x2ecc71 : 0xe74c3c);

        const components = [
            row(
                btn('comissao_open', '🟢 Open Commissions', ButtonStyle.Success),
                btn('comissao_close', '🔴 Close Commissions', ButtonStyle.Danger)
            ),
            row(
                btn('comissao_slots', '⚙️ Change Slots', ButtonStyle.Secondary),
                btn('comissao_view', '👥 View Commissions', ButtonStyle.Primary)
            ),
            row(
                btn(`commgr_clients_${store}`, '🗂️ Manage Clients', ButtonStyle.Primary),
                btn(`commgr_reset_${store}`, '🗑️ Reset All', ButtonStyle.Danger)
            )
        ];
        return interaction.editReply({ embeds: [e], components });
    }

    // ==========================================================================
    // === BANCO DE DADOS =======================================================
    // ==========================================================================
    (async () => {
        try {
            await pool.query(`CREATE TABLE IF NOT EXISTS commission_configs (store TEXT PRIMARY KEY, status TEXT DEFAULT 'CLOSED', total_slots INT DEFAULT 0, available_slots INT DEFAULT 0, clients_in_progress INT DEFAULT 0, solid_colors_enabled BOOLEAN DEFAULT FALSE, solid_colors_limit INT DEFAULT 0, stamps_with_ref_enabled BOOLEAN DEFAULT FALSE, stamps_with_ref_limit INT DEFAULT 0, stamps_without_ref_enabled BOOLEAN DEFAULT FALSE, stamps_without_ref_limit INT DEFAULT 0, allowed_patterns TEXT[] DEFAULT '{}', custom_patterns TEXT[] DEFAULT '{}', updated_at TIMESTAMP DEFAULT NOW())`);
            await pool.query(`CREATE TABLE IF NOT EXISTS active_commissions (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, request_id TEXT UNIQUE, user_id TEXT NOT NULL, store TEXT NOT NULL, status TEXT DEFAULT 'PENDING', mesh_quantity INT DEFAULT 0, mesh_description TEXT, mesh_changes TEXT, mesh_references TEXT[], rigging_confirmed BOOLEAN DEFAULT FALSE, payment_method TEXT, texturization_requested BOOLEAN DEFAULT FALSE, texturization_type TEXT, texturization_quantity INT DEFAULT 0, selected_patterns TEXT[], selected_colors TEXT[], print_references TEXT[], reviewed_by TEXT, decline_type TEXT, decline_reason TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);

            const newCols = [
                'transfer_from_store TEXT', 'transfer_from_request_id TEXT', 'transfer_target_store TEXT',
                'transfer_reason_type TEXT', 'transfer_reason_text TEXT',
                'transfer_fallback_type TEXT', 'transfer_fallback_text TEXT',
                'transfer_status TEXT', 'transfer_expires_at TIMESTAMP', 'transferred_by TEXT'
            ];
            for (const c of newCols) await pool.query(`ALTER TABLE active_commissions ADD COLUMN IF NOT EXISTS ${c}`);

            await pool.query(`CREATE TABLE IF NOT EXISTS commission_counters (store TEXT PRIMARY KEY, last_number INT DEFAULT 0)`);
            await pool.query(`CREATE TABLE IF NOT EXISTS commission_history (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, request_id TEXT, user_id TEXT, store TEXT, status TEXT, payload JSONB, deleted_by TEXT, deleted_reason TEXT, deleted_at TIMESTAMP DEFAULT NOW())`);
            await pool.query(`INSERT INTO commission_configs (store) VALUES ('occult'),('side'),('occult_x_side') ON CONFLICT DO NOTHING`);

            // Migra o contador para o maior número já existente (não repete códigos antigos)
            for (const st of STORES) {
                const mx = await pool.query(`SELECT COALESCE(MAX(CAST(SUBSTRING(request_id FROM 'C([0-9]+)$') AS INT)),0) AS mx FROM active_commissions WHERE store=$1`, [st]);
                await pool.query(`INSERT INTO commission_counters (store,last_number) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [st, mx.rows[0].mx]);
            }
            console.log('✅ [COMMISSION] Tabelas prontas');
        } catch (e) { console.error('❌ [COMMISSION] DB init:', e.message); }
    })();

    // ==========================================================================
    // === MESSAGE LISTENER (imagens por DM) ====================================
    // ==========================================================================
    client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot) return;
        if (message.guildId) return; // só DM

        const uid = message.author.id;
        const s = clientSession[uid];
        if (!s) return;

        // ---------- SUGGESTIONS ----------
        if (s.step === 'suggestion_images') {
            const urls = message.attachments.map(a => a.url).slice(0, MAX_SUGGESTION_IMAGES);
            if (!urls.length) return message.reply('🖼️ Please attach at least one image (up to 10 in a single message).');
            try {
                const ch = await client.channels.fetch(OUTFIT_IDEAS_CHANNEL_ID).catch(() => null);
                if (ch) {
                    const embeds = urls.map(u => new EmbedBuilder().setImage(u).setColor(0xf1c40f));
                    await ch.send({
                        content: `💡 **${message.author.username}** sent an outfit idea!\n👤 User: <@${uid}>\n🆔 ID: \`${uid}\`\n🖼️ Images: ${urls.length}`,
                        embeds
                    });
                }
                await message.reply('✅ Your idea was sent successfully! Thank you for sharing it with us ✨');
                if (s.suggestion?.interaction) {
                    await s.suggestion.interaction.followUp({
                        content: '✅ **Idea sent successfully!** Thank you for sharing it with us ✨',
                        ...EP
                    }).catch(() => { });
                }
                console.log(`[SUGGESTION] ${uid} enviou ${urls.length} imagem(ns)`);
            } catch (e) {
                console.error('[SUGGESTION] erro:', e.message);
                await message.reply('❌ Something went wrong. Please try again later.');
            }
            delete clientSession[uid];
            return;
        }

        // ---------- REFERÊNCIAS DA COMISSÃO ----------
        if (s.step === 'commission_mesh_refs' || s.step === 'commission_print_refs') {
            const c = s.commission;
            if (!c) return;
            const urls = message.attachments.map(a => a.url).slice(0, 10);

            if (!urls.length) {
                if (/^skip$/i.test(message.content.trim())) {
                    // continua sem imagens
                } else {
                    return message.reply('🖼️ Please attach images, or type `skip`.');
                }
            }

            const isMesh = s.step === 'commission_mesh_refs';
            if (isMesh) c.mesh_references = urls;
            else c.print_references = urls;

            await message.reply(`✅ ${urls.length} image(s) received privately! You can continue in the server.`);
            await logCommission(uid, `${isMesh ? 'Mesh' : 'Print'} references received (${urls.length})`, { store: c.store });

            const payload = isMesh ? riggingPayload() : paymentPayload();
            s.step = isMesh ? 'commission_rigging' : 'commission_payment';
            resetSessionTimer(uid);

            let ok = false;
            if (c.interaction) {
                ok = await c.interaction.followUp({ ...payload, ...EP }).then(() => true).catch(() => false);
            }
            if (!ok) await message.reply(payload);
            return;
        }

        // ---------- WIZARD ADMIN (slots / limites / patterns) ----------
        const w = adminWizard[uid];
        if (!w || w.type !== 'commission') return;

        if (w.step === 'ask_slots' || w.step === 'ask_slots_update') {
            const num = parseInt(message.content.trim());
            if (isNaN(num) || num <= 0 || num > 100) return message.reply('❌ Type a number between 1 and 100.');
            if (w.step === 'ask_slots_update') {
                await pool.query(`UPDATE commission_configs SET total_slots=$1, available_slots=$1, updated_at=NOW() WHERE store=$2`, [num, w.store]);
                delete adminWizard[uid];
                return message.reply(`✅ Slots for \`${storeLabel(w.store)}\` updated to \`${num}\`.`);
            }
            w.temp_slots = num;
            w.step = 'ask_services';
            return message.reply({
                content: '🎨 Select the types of commissions you want to accept:',
                components: [row(
                    btn('comm_srv_solid', '1. Solid colors: ⭕'),
                    btn('comm_srv_ref', '2. Prints w/ ref: ⭕'),
                    btn('comm_srv_no_ref', '3. Prints w/o ref: ⭕')
                ), row(btn('comm_srv_continue', 'Continue ➡️', ButtonStyle.Primary))]
            });
        }
        if (w.step === 'ask_solid_limit') {
            const n = parseInt(message.content.trim());
            if (isNaN(n) || n < 0) return message.reply('❌ Invalid number.');
            w.solid_limit = n; w.step = 'ask_ref_limit';
            return message.reply('🖼️ How many prints WITH reference? (number or 0)');
        }
        if (w.step === 'ask_ref_limit') {
            const n = parseInt(message.content.trim());
            if (isNaN(n) || n < 0) return message.reply('❌ Invalid number.');
            w.ref_limit = n; w.step = 'ask_no_ref_limit';
            return message.reply('🎭 How many prints WITHOUT reference? (number or 0)');
        }
        if (w.step === 'ask_no_ref_limit') {
            const n = parseInt(message.content.trim());
            if (isNaN(n) || n < 0) return message.reply('❌ Invalid number.');
            w.no_ref_limit = n;
            return finishCommissionWizard(message, w);
        }
        if (w.step === 'ask_no_ref_custom') {
            w.custom_patterns = /^skip$/i.test(message.content.trim()) ? [] : message.content.split(',').map(x => x.trim()).filter(Boolean);
            return finishCommissionWizard(message, w);
        }
    });

    async function finishCommissionWizard(source, w) {
        await pool.query(
            `UPDATE commission_configs SET status='OPEN', total_slots=$1, available_slots=$1, solid_colors_enabled=$2, solid_colors_limit=$3, stamps_with_ref_enabled=$4, stamps_with_ref_limit=$5, stamps_without_ref_enabled=$6, stamps_without_ref_limit=$7, allowed_patterns=$8, custom_patterns=$9, updated_at=NOW() WHERE store=$10`,
            [w.temp_slots, w.services.solid, w.solid_limit || 0, w.services.ref, w.ref_limit || 0, w.services.no_ref, w.no_ref_limit || 0, w.selected_patterns || [], w.custom_patterns || [], w.store]);
        const uid = source.author?.id || source.user?.id;
        delete adminWizard[uid];
        const msg = `✅ Commissions opened!\n🏪 ${storeLabel(w.store)}\n🎟️ Slots: ${w.temp_slots}\n🎨 Solid: ${w.services.solid ? `Yes (${w.solid_limit})` : 'No'}\n🖼️ w/ ref: ${w.services.ref ? `Yes (${w.ref_limit})` : 'No'}\n🎭 w/o ref: ${w.services.no_ref ? `Yes (${w.no_ref_limit})` : 'No'}`;
        if (source.reply && !source.replied && !source.deferred) return source.reply(msg);
        if (source.editReply) return source.editReply({ content: msg, embeds: [], components: [] });
        if (source.channel) return source.channel.send(msg);
    }

    // ==========================================================================
    // === INTERACTION LISTENER =================================================
    // ==========================================================================
    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            const id = interaction.customId || '';
            const uid = interaction.user.id;
            const isCmd = interaction.isChatInputCommand();
            const isBtn = interaction.isButton();
            const isSel = interaction.isStringSelectMenu();
            const isMod = interaction.isModalSubmit();

            const relevant =
                (isCmd && ['commission', 'commission-painel', 'suggestions-painel'].includes(interaction.commandName)) ||
                (!isCmd && (id.startsWith('comm_') || id.startsWith('commgr_') || id.startsWith('comissao_') ||
                    id.startsWith('client_commission_') || id.startsWith('admin_commission_') ||
                    id.startsWith('admin_decline_') || id.startsWith('suggestion_')));
            if (!relevant) return;

            if (clientSession[uid]) resetSessionTimer(uid);

            // ==================================================================
            // === /suggestions-painel ==========================================
            // ==================================================================
            if (isCmd && interaction.commandName === 'suggestions-painel') {
                if (!await isAdmin(interaction)) return interaction.reply({ content: '❌ No permission.', ...EP });
                const embed = new EmbedBuilder()
                    .setTitle('💡 OUTFIT SUGGESTIONS')
                    .setDescription('Commissions closed, but still have an idea for Occultside? Share it with us! ✨\n\nSuggestions are not guaranteed to be produced or recreated exactly as requested. Approved ideas will be released in our store as **Premades**.')
                    .setColor(0xf1c40f);
                await interaction.reply({ embeds: [embed], components: [row(btn('suggestion_submit', '🖼️ Submit an Idea', ButtonStyle.Primary))] });
                return;
            }

            if (isBtn && id === 'suggestion_submit') {
                await interaction.deferReply(EP);
                clientSession[uid] = { step: 'suggestion_images', suggestion: { interaction }, lastActivity: Date.now() };
                resetSessionTimer(uid);
                const sent = await dmUser(uid, {
                    embeds: [new EmbedBuilder()
                        .setTitle('🖼️ Submit your Outfit Idea')
                        .setDescription(`Send **all your images in ONE message** here in this private DM (up to ${MAX_SUGGESTION_IMAGES}).\n\n🔒 Nothing will be posted in the server channel.`)
                        .setColor(0xf1c40f)]
                });
                return interaction.editReply({
                    content: sent
                        ? '📩 I sent you a **private DM**! Send your images there. Nothing will appear in this channel.'
                        : '❌ I could not DM you. Please enable DMs from server members and try again.'
                });
            }

            // ==================================================================
            // === /commission (ADMIN) ==========================================
            // ==================================================================
            if (isCmd && interaction.commandName === 'commission') {
                if (!await isAdmin(interaction)) return interaction.reply({ content: '❌ No permission.', ...EP });
                await interaction.deferReply(EP);
                return interaction.editReply({
                    content: '🎨 **COMMISSION ADMIN PANEL**\nSelect the store:',
                    components: [row(
                        btn('comissao_store_occult', '🛒 Occult', ButtonStyle.Primary),
                        btn('comissao_store_side', '🛒 Side', ButtonStyle.Primary),
                        btn('comissao_store_occult_x_side', '🛒 Occult x Side', ButtonStyle.Primary)
                    )]
                });
            }

            if (isBtn && id.startsWith('comissao_store_')) {
                await interaction.deferReply(EP);
                const store = id.replace('comissao_store_', '');
                adminWizard[uid] = { type: 'commission', store, step: 'panel' };
                return showCommissionPanel(interaction, store);
            }

            if (isBtn && ['comissao_open', 'comissao_close', 'comissao_slots', 'comissao_view'].includes(id)) {
                const w = adminWizard[uid];
                if (!w || w.type !== 'commission') return interaction.reply({ content: '❌ Session expired. Use /commission.', ...EP });

                if (id === 'comissao_open') {
                    w.step = 'ask_slots';
                    w.services = { solid: false, ref: false, no_ref: false };
                    return interaction.update({ content: '1️⃣ **Slot Configuration**\nHow many slots? *Type a number in chat.*', embeds: [], components: [] });
                }
                if (id === 'comissao_close') {
                    await pool.query(`UPDATE commission_configs SET status='CLOSED', updated_at=NOW() WHERE store=$1`, [w.store]);
                    await interaction.deferReply(EP);
                    return showCommissionPanel(interaction, w.store);
                }
                if (id === 'comissao_slots') {
                    w.step = 'ask_slots_update';
                    return interaction.update({ content: '⚙️ **Change Slots**\nType the new total number of slots:', embeds: [], components: [] });
                }
                if (id === 'comissao_view') {
                    await interaction.deferReply(EP);
                    const comms = await pool.query(`SELECT * FROM active_commissions WHERE store=$1 AND status IN ('PENDING','ACCEPTED') ORDER BY created_at DESC LIMIT 25`, [w.store]);
                    if (!comms.rows.length) return interaction.editReply({ content: 'ℹ️ No active commissions in this store.' });
                    let msg = `👥 **Active — ${storeLabel(w.store)}** (${comms.rows.length})\n`;
                    const buttons = [];
                    for (const c of comms.rows) {
                        const u = await client.users.fetch(c.user_id).catch(() => null);
                        msg += `${c.status === 'PENDING' ? '⏳' : '✅'} \`${c.request_id}\` — ${u ? u.username : c.user_id}\n`;
                        buttons.push(btn(`admin_commission_details_${c.request_id}`, c.request_id, ButtonStyle.Primary));
                    }
                    return interaction.editReply({ content: cut(msg, 2000), components: chunkButtons(buttons) });
                }
            }

            if (isBtn && id.startsWith('comm_srv_')) {
                const w = adminWizard[uid];
                if (!w || w.type !== 'commission') return interaction.reply({ content: '❌ Session expired.', ...EP });
                if (id === 'comm_srv_solid') w.services.solid = !w.services.solid;
                if (id === 'comm_srv_ref') w.services.ref = !w.services.ref;
                if (id === 'comm_srv_no_ref') w.services.no_ref = !w.services.no_ref;

                if (id === 'comm_srv_continue') {
                    if (w.services.solid) { w.step = 'ask_solid_limit'; return interaction.update({ content: '3️⃣ **Solid colors limit** — how many per client?', components: [] }); }
                    if (w.services.ref) { w.step = 'ask_ref_limit'; return interaction.update({ content: '4️⃣ **Prints w/ reference limit** — how many per client?', components: [] }); }
                    if (w.services.no_ref) {
                        w.step = 'ask_no_ref_patterns';
                        const sel = new StringSelectMenuBuilder().setCustomId('comm_patterns_select').setPlaceholder('Select available patterns')
                            .setMinValues(1).setMaxValues(6).addOptions(COMMISSION_PATTERNS.map(p => ({ label: p, value: p })));
                        return interaction.update({ content: '5️⃣ **Available patterns**', components: [row(sel)] });
                    }
                    await interaction.deferUpdate();
                    return finishCommissionWizard(interaction, w);
                }

                return interaction.update({
                    content: `2️⃣ **Texturization services — ${storeLabel(w.store)}**`,
                    components: [
                        row(
                            btn('comm_srv_solid', `1. Solid colors: ${w.services.solid ? '✅' : '⭕'}`, w.services.solid ? ButtonStyle.Success : ButtonStyle.Secondary),
                            btn('comm_srv_ref', `2. Prints w/ ref: ${w.services.ref ? '✅' : '⭕'}`, w.services.ref ? ButtonStyle.Success : ButtonStyle.Secondary),
                            btn('comm_srv_no_ref', `3. Prints w/o ref: ${w.services.no_ref ? '✅' : '⭕'}`, w.services.no_ref ? ButtonStyle.Success : ButtonStyle.Secondary)
                        ),
                        row(btn('comm_srv_continue', 'Continue ➡️', ButtonStyle.Primary))
                    ]
                });
            }

            if (isSel && id === 'comm_patterns_select') {
                const w = adminWizard[uid];
                if (!w) return interaction.reply({ content: '❌ Session expired.', ...EP });
                w.selected_patterns = interaction.values;
                w.step = 'ask_no_ref_custom';
                return interaction.update({ content: '✨ **Custom patterns (optional)**\nType extra patterns separated by commas, or `skip`:', components: [] });
            }

            // ==================================================================
            // === GERENCIADOR DE CLIENTES ======================================
            // ==================================================================
            if (isBtn && id.startsWith('commgr_clients_')) {
                await interaction.deferReply(EP);
                const store = id.replace('commgr_clients_', '');
                const res = await pool.query(`SELECT user_id, COUNT(*)::int AS total FROM active_commissions WHERE store=$1 GROUP BY user_id ORDER BY total DESC LIMIT 25`, [store]);
                if (!res.rows.length) return interaction.editReply({ content: 'ℹ️ No clients with commissions in this store.' });

                const opts = [];
                for (const r of res.rows) {
                    const u = await client.users.fetch(r.user_id).catch(() => null);
                    opts.push({ label: cut(u ? u.username : r.user_id, 100), value: r.user_id, description: `${r.total} commission(s)` });
                }
                const sel = new StringSelectMenuBuilder().setCustomId(`commgr_clisel_${store}`).setPlaceholder('Select a client to manage').addOptions(opts);
                return interaction.editReply({ content: `🗂️ **Clients — ${storeLabel(store)}**`, components: [row(sel)] });
            }

            if (isSel && id.startsWith('commgr_clisel_')) {
                await interaction.deferReply(EP);
                const store = id.replace('commgr_clisel_', '');
                const target = interaction.values[0];
                const u = await client.users.fetch(target).catch(() => null);
                const comms = await pool.query(`SELECT * FROM active_commissions WHERE store=$1 AND user_id=$2 ORDER BY created_at DESC`, [store, target]);
                let d = `👤 ${u ? u.username : target}\n🆔 \`${target}\`\n🏪 ${storeLabel(store)}\n━━━━━━━━━━━━━━━━━━━━\n`;
                for (const c of comms.rows) d += `\`${c.request_id}\` — ${c.status} — ${c.created_at ? formatBrasiliaDate(new Date(c.created_at)) : ''}\n`;
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle('🗂️ Client Commissions').setDescription(cut(d, 4096)).setColor(0x3498db)],
                    components: [row(
                        btn(`commgr_delone_${store}_${target}`, '🗑️ Delete one', ButtonStyle.Danger),
                        btn(`commgr_delall_${store}_${target}`, '🗑️ Delete ALL from client', ButtonStyle.Danger)
                    )]
                });
            }

            if (isBtn && id.startsWith('commgr_delone_')) {
                await interaction.deferReply(EP);
                const rest = id.replace('commgr_delone_', '');
                const i = rest.lastIndexOf('_');
                const store = rest.substring(0, i), target = rest.substring(i + 1);
                const comms = await pool.query(`SELECT request_id, status FROM active_commissions WHERE store=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 25`, [store, target]);
                if (!comms.rows.length) return interaction.editReply({ content: 'ℹ️ Nothing to delete.' });
                const sel = new StringSelectMenuBuilder().setCustomId(`commgr_delsel_${store}_${target}`).setPlaceholder('Select the commission to DELETE')
                    .addOptions(comms.rows.map(c => ({ label: c.request_id, value: c.request_id, description: c.status })));
                return interaction.editReply({ content: '🗑️ Select one commission to delete:', components: [row(sel)] });
            }

            if (isSel && id.startsWith('commgr_delsel_')) {
                await interaction.deferReply(EP);
                const requestId = interaction.values[0];
                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [requestId])).rows[0];
                if (!comm) return interaction.editReply({ content: '❌ Commission not found (already deleted?).' });
                await archiveCommission(comm, uid, 'Deleted by admin');
                await pool.query(`DELETE FROM active_commissions WHERE request_id=$1`, [requestId]);
                if (['PENDING', 'ACCEPTED'].includes(comm.status)) await freeSlot(comm.store);
                await dmUser(comm.user_id, {
                    embeds: [new EmbedBuilder().setTitle('🗑️ Commission Cancelled')
                        .setDescription(`Your commission \`${requestId}\` was cancelled and removed by the store administration.\nIf you have questions, please contact support.`)
                        .setColor(0xe74c3c)],
                    components: [backToStoreRow()]
                });
                await logCommission(comm.user_id, `Commission ${requestId} deleted by admin`, { requestId, store: comm.store });
                return interaction.editReply({ content: `✅ Commission \`${requestId}\` deleted. Slot released. Client notified.` });
            }

            if (isBtn && id.startsWith('commgr_delall_')) {
                const rest = id.replace('commgr_delall_', '');
                const i = rest.lastIndexOf('_');
                const store = rest.substring(0, i), target = rest.substring(i + 1);
                const modal = new ModalBuilder().setCustomId(`commgr_delall_modal_${store}_${target}`).setTitle('Delete ALL from client')
                    .addComponents(row(new TextInputBuilder().setCustomId('confirm').setLabel('Type DELETE to confirm').setStyle(TextInputStyle.Short).setRequired(true)));
                return interaction.showModal(modal);
            }

            if (isMod && id.startsWith('commgr_delall_modal_')) {
                await interaction.deferReply(EP);
                if (interaction.fields.getTextInputValue('confirm').trim().toUpperCase() !== 'DELETE')
                    return interaction.editReply({ content: '❌ Cancelled (wrong confirmation word).' });
                const rest = id.replace('commgr_delall_modal_', '');
                const i = rest.lastIndexOf('_');
                const store = rest.substring(0, i), target = rest.substring(i + 1);
                const comms = await pool.query(`SELECT * FROM active_commissions WHERE store=$1 AND user_id=$2`, [store, target]);
                for (const c of comms.rows) {
                    await archiveCommission(c, uid, 'Bulk delete (client)');
                    if (['PENDING', 'ACCEPTED'].includes(c.status)) await freeSlot(store);
                }
                await pool.query(`DELETE FROM active_commissions WHERE store=$1 AND user_id=$2`, [store, target]);
                await dmUser(target, {
                    embeds: [new EmbedBuilder().setTitle('🗑️ Commissions Cancelled')
                        .setDescription(`All your commissions at \`${storeLabel(store)}\` were cancelled by the administration.`).setColor(0xe74c3c)],
                    components: [backToStoreRow()]
                });
                return interaction.editReply({ content: `✅ ${comms.rows.length} commission(s) deleted for <@${target}>.` });
            }

            if (isBtn && id.startsWith('commgr_reset_')) {
                const store = id.replace('commgr_reset_', '');
                const modal = new ModalBuilder().setCustomId(`commgr_reset_modal_${store}`).setTitle('RESET ALL COMMISSIONS')
                    .addComponents(row(new TextInputBuilder().setCustomId('confirm').setLabel('Type RESET to delete EVERYTHING').setStyle(TextInputStyle.Short).setRequired(true)));
                return interaction.showModal(modal);
            }

            if (isMod && id.startsWith('commgr_reset_modal_')) {
                await interaction.deferReply(EP);
                if (interaction.fields.getTextInputValue('confirm').trim().toUpperCase() !== 'RESET')
                    return interaction.editReply({ content: '❌ Cancelled (wrong confirmation word).' });
                const store = id.replace('commgr_reset_modal_', '');
                const comms = await pool.query(`SELECT * FROM active_commissions WHERE store=$1`, [store]);
                for (const c of comms.rows) {
                    await archiveCommission(c, uid, 'Store reset');
                    await dmUser(c.user_id, {
                        embeds: [new EmbedBuilder().setTitle('🔄 Commissions Reset')
                            .setDescription(`The commission queue at \`${storeLabel(store)}\` was reset.\nYour request \`${c.request_id}\` was cancelled. Please submit again if you are still interested.`)
                            .setColor(0xe67e22)],
                        components: [backToStoreRow()]
                    });
                }
                await pool.query(`DELETE FROM active_commissions WHERE store=$1`, [store]);
                await pool.query(`UPDATE commission_configs SET available_slots = total_slots, clients_in_progress = 0, updated_at = NOW() WHERE store=$1`, [store]);
                return interaction.editReply({ content: `✅ Reset complete: ${comms.rows.length} commission(s) removed.\nℹ️ The numbering counter was **kept**, so new codes will never repeat old ones.` });
            }

            // ==================================================================
            // === PAINEL PÚBLICO DO CLIENTE ====================================
            // ==================================================================
            if (isCmd && interaction.commandName === 'commission-painel') {
                if (!await isAdmin(interaction)) return interaction.reply({ content: '❌ No permission.', ...EP });
                const embed = new EmbedBuilder()
                    .setTitle('🎨 Open Commissions')
                    .setDescription('Request a custom commission with our artists!\n\n**How it works:**\n1️⃣ Choose the store\n2️⃣ Fill in your order details (private)\n3️⃣ Wait for administrator approval\n4️⃣ Complete payment\n5️⃣ Receive your commission!\n\n⚠️ **Rigging is NOT included.**\n🔒 Everything you send stays private.')
                    .setColor(0x9b59b6).setTimestamp();
                return interaction.reply({ embeds: [embed], components: [row(btn('client_commission_start', '🎨 Request Commission', ButtonStyle.Primary))] });
            }

            if (isBtn && id === 'comm_back_store') {
                await interaction.deferReply(EP);
                return interaction.editReply({
                    content: '🛒 **Back to the store!** Choose where you want to shop:',
                    components: [row(
                        btn('client_store_occult', '🛒 Occult', ButtonStyle.Primary),
                        btn('client_store_side', '🛒 Side', ButtonStyle.Primary),
                        btn('client_store_occult_x_side', '🛒 OccultSide', ButtonStyle.Primary)
                    )]
                });
            }

            if (isBtn && id === 'client_commission_start') {
                await interaction.deferReply(EP);
                const open = await pool.query(`SELECT store, available_slots FROM commission_configs WHERE status='OPEN' AND available_slots > 0`);
                if (!open.rows.length) return interaction.editReply({ content: '❌ **No commissions currently open.**', components: [backToStoreRow()] });
                const buttons = open.rows.map(s => btn(`client_commission_store_${s.store}`, `🛒 ${storeLabel(s.store)}`, ButtonStyle.Primary));
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle('🎨 Request Commission').setDescription('Select the store:').setColor(0x9b59b6)],
                    components: chunkButtons(buttons)
                });
            }

            if (isBtn && id.startsWith('client_commission_store_')) {
                await interaction.deferReply(EP);
                const store = id.replace('client_commission_store_', '');
                const config = (await pool.query(`SELECT * FROM commission_configs WHERE store=$1 AND status='OPEN'`, [store])).rows[0];
                if (!config || config.available_slots <= 0) return interaction.editReply({ content: '❌ This store just ran out of slots!', components: [backToStoreRow()] });

                clientSession[uid] = { step: 'commission_mesh', commission: { store, config, interaction }, lastActivity: Date.now() };
                resetSessionTimer(uid);
                await logCommission(uid, `Started commission request at ${storeLabel(store)}`, { store, username: interaction.user.username });

                return interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('📐 Step 1/5 — Mesh Details')
                        .setDescription(`Store: \`${storeLabel(store)}\`\nSlots: \`${config.available_slots}/${config.total_slots}\`\n\nClick below to fill in your mesh details.\n🔒 The form is **private** — nothing appears in the channel.`)
                        .setColor(0x3498db)],
                    components: [row(btn('comm_open_mesh_modal', '📝 Fill mesh details', ButtonStyle.Primary), btn('comm_cancel', '❌ Cancel', ButtonStyle.Danger))]
                });
            }

            // ---------- MODAL: MESH ----------
            if (isBtn && id === 'comm_open_mesh_modal') {
                const s = clientSession[uid];
                if (!s?.commission) return interaction.reply({ content: '❌ Session expired. Start again.', ...EP });
                const modal = new ModalBuilder().setCustomId('comm_modal_mesh').setTitle('Mesh Details').addComponents(
                    row(new TextInputBuilder().setCustomId('qty').setLabel('How many meshes? (1-50)').setStyle(TextInputStyle.Short).setRequired(true)),
                    row(new TextInputBuilder().setCustomId('desc').setLabel('Describe the mesh (style, body, parts)').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                    row(new TextInputBuilder().setCustomId('changes').setLabel('Any changes? Type none if no changes').setStyle(TextInputStyle.Paragraph).setRequired(false))
                );
                return interaction.showModal(modal);
            }

            if (isMod && id === 'comm_modal_mesh') {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired. Start again.' });
                const qty = parseInt(interaction.fields.getTextInputValue('qty').trim());
                if (isNaN(qty) || qty < 1 || qty > 50) return interaction.editReply({ content: '❌ Invalid quantity (1-50). Click the form button again.', components: [row(btn('comm_open_mesh_modal', '📝 Try again', ButtonStyle.Primary))] });
                const c = s.commission;
                c.mesh_quantity = qty;
                c.mesh_description = interaction.fields.getTextInputValue('desc').trim();
                const ch = interaction.fields.getTextInputValue('changes').trim();
                c.mesh_changes = !ch || /^(none|no|skip)$/i.test(ch) ? 'As provided' : ch;
                c.interaction = interaction;
                s.step = 'commission_mesh_refs';
                return interaction.editReply({ content: '✅ Mesh details saved!', ...refsPayload('mesh') });
            }

            // ---------- REFERÊNCIAS ----------
            if (isBtn && (id === 'comm_refs_dm' || id === 'comm_printrefs_dm')) {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                const isMesh = id === 'comm_refs_dm';
                s.step = isMesh ? 'commission_mesh_refs' : 'commission_print_refs';
                s.commission.interaction = interaction;
                const sent = await dmUser(uid, {
                    embeds: [new EmbedBuilder()
                        .setTitle(isMesh ? '🖼️ Mesh References' : '🖼️ Print References')
                        .setDescription('Send **all images in ONE message** here (up to 10).\nOr type `skip` if you have none.\n\n🔒 This DM is private.')
                        .setColor(0x3498db)]
                });
                return interaction.editReply({ content: sent ? '📩 Check your **private DM** to send the images.' : '❌ I could not DM you. Enable DMs and try again.' });
            }

            if (isBtn && (id === 'comm_refs_skip' || id === 'comm_printrefs_skip')) {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                const isMesh = id === 'comm_refs_skip';
                if (isMesh) { s.commission.mesh_references = []; s.step = 'commission_rigging'; return interaction.editReply(riggingPayload()); }
                s.commission.print_references = [];
                s.step = 'commission_payment';
                return interaction.editReply(paymentPayload());
            }

            // ---------- RIGGING ----------
            if (isBtn && id === 'comm_rig_yes') {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                s.commission.rigging_confirmed = true;
                s.commission.interaction = interaction;
                s.step = 'commission_texturization';
                return interaction.editReply(texturizationPayload());
            }
            if (isBtn && id === 'comm_rig_no') {
                await interaction.deferReply(EP);
                delete clientSession[uid];
                return interaction.editReply({
                    content: '⚠️ You must acknowledge that **rigging is NOT included** to request a commission.',
                    components: [backToStoreRow()]
                });
            }

            // ---------- TEXTURIZAÇÃO ----------
            if (isBtn && id === 'comm_text_no') {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                s.commission.texturization_requested = false;
                s.commission.interaction = interaction;
                s.step = 'commission_payment';
                return interaction.editReply(paymentPayload());
            }

            if (isBtn && id === 'comm_text_yes') {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                s.commission.texturization_requested = true;
                s.commission.interaction = interaction;
                const cfg = s.commission.config;
                const opts = [];
                if (cfg.solid_colors_enabled) opts.push({ label: '🎨 Solid Colors', value: 'solid_colors', description: 'Uniform colors, no prints' });
                if (cfg.stamps_with_ref_enabled) opts.push({ label: '🖼️ Prints with Reference', value: 'prints_with_ref', description: 'Based on your images' });
                if (cfg.stamps_without_ref_enabled) opts.push({ label: '🎭 Prints without Reference', value: 'prints_without_ref', description: 'Store patterns' });
                if (!opts.length) {
                    s.commission.texturization_requested = false;
                    s.step = 'commission_payment';
                    return interaction.editReply(paymentPayload());
                }
                s.step = 'commission_text_type';
                const sel = new StringSelectMenuBuilder().setCustomId('comm_text_type').setPlaceholder('Select a type...').addOptions(opts);
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle('🎨 Texturization Type').setDescription('Select the type you want:').setColor(0x3498db)],
                    components: [row(sel)]
                });
            }

            if (isSel && id === 'comm_text_type') {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                const cfg = s.commission.config;
                const t = interaction.values[0];
                s.commission.texturization_type = t;
                s.commission.interaction = interaction;
                s.step = 'commission_text_qty';
                const max = t === 'solid_colors' ? (cfg.solid_colors_limit || 10) : t === 'prints_with_ref' ? (cfg.stamps_with_ref_limit || 10) : (cfg.stamps_without_ref_limit || 10);
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle('🔢 Quantity').setDescription(`How many **${typeLabel(t)}**?\nMaximum: \`${max}\``).setColor(0x3498db)],
                    components: [row(btn('comm_open_qty_modal', '🔢 Enter quantity', ButtonStyle.Primary))]
                });
            }

            if (isBtn && id === 'comm_open_qty_modal') {
                const s = clientSession[uid];
                if (!s?.commission) return interaction.reply({ content: '❌ Session expired.', ...EP });
                return interaction.showModal(new ModalBuilder().setCustomId('comm_modal_qty').setTitle('Texturization Quantity')
                    .addComponents(row(new TextInputBuilder().setCustomId('qty').setLabel('How many?').setStyle(TextInputStyle.Short).setRequired(true))));
            }

            if (isMod && id === 'comm_modal_qty') {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                const cfg = s.commission.config, c = s.commission;
                const t = c.texturization_type;
                const max = t === 'solid_colors' ? (cfg.solid_colors_limit || 10) : t === 'prints_with_ref' ? (cfg.stamps_with_ref_limit || 10) : (cfg.stamps_without_ref_limit || 10);
                const n = parseInt(interaction.fields.getTextInputValue('qty').trim());
                if (isNaN(n) || n < 1 || n > max) return interaction.editReply({ content: `❌ Enter a number between 1 and ${max}.`, components: [row(btn('comm_open_qty_modal', '🔢 Try again', ButtonStyle.Primary))] });
                c.texturization_quantity = n;
                c.interaction = interaction;

                if (t === 'prints_without_ref') {
                    const list = [...new Set([...(cfg.allowed_patterns || []), ...(cfg.custom_patterns || [])])];
                    const uniq = list.length ? list : COMMISSION_PATTERNS;
                    s.step = 'commission_patterns';
                    const sel = new StringSelectMenuBuilder().setCustomId('comm_patterns_client').setPlaceholder('Select the patterns')
                        .setMinValues(1).setMaxValues(Math.min(uniq.length, 25)).addOptions(uniq.slice(0, 25).map(p => ({ label: p, value: p })));
                    return interaction.editReply({ content: '🎯 **Select the patterns:**', components: [row(sel)] });
                }
                if (t === 'prints_with_ref') { s.step = 'commission_print_refs'; return interaction.editReply(refsPayload('print')); }
                s.step = 'commission_colors';
                return interaction.editReply({
                    content: '🎨 **Which solid colors?**',
                    components: [row(btn('comm_open_colors_modal', '🎨 Enter colors', ButtonStyle.Primary))]
                });
            }

            if (isBtn && id === 'comm_open_colors_modal') {
                return interaction.showModal(new ModalBuilder().setCustomId('comm_modal_colors').setTitle('Solid Colors')
                    .addComponents(row(new TextInputBuilder().setCustomId('colors').setLabel('Colors (comma separated)').setPlaceholder('Black, White, Red').setStyle(TextInputStyle.Short).setRequired(true))));
            }

            if (isMod && id === 'comm_modal_colors') {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                s.commission.selected_colors = interaction.fields.getTextInputValue('colors').split(',').map(x => x.trim()).filter(Boolean);
                s.commission.interaction = interaction;
                s.step = 'commission_payment';
                return interaction.editReply(paymentPayload());
            }

            if (isSel && id === 'comm_patterns_client') {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                s.commission.selected_patterns = interaction.values;
                s.commission.interaction = interaction;
                s.step = 'commission_payment';
                return interaction.editReply(paymentPayload());
            }

            // ---------- PAGAMENTO (SEM CRÉDITOS) ----------
            if (isBtn && id.startsWith('comm_pay_')) {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                s.commission.payment_method = id.replace('comm_pay_', '');
                s.commission.interaction = interaction;
                s.step = 'commission_review';
                return interaction.editReply(reviewPayload(s.commission));
            }

            if (isBtn && id === 'comm_cancel') {
                await interaction.deferReply(EP);
                delete clientSession[uid];
                await logCommission(uid, 'Commission request cancelled by client', {});
                return interaction.editReply({ content: '❌ Commission request cancelled.', embeds: [], components: [backToStoreRow()] });
            }

            // ---------- SUBMIT ----------
            if (isBtn && id === 'comm_submit') {
                await interaction.deferReply(EP);
                const s = clientSession[uid];
                if (!s?.commission) return interaction.editReply({ content: '❌ Session expired.' });
                const c = s.commission;

                const check = (await pool.query(`SELECT available_slots FROM commission_configs WHERE store=$1 AND status='OPEN'`, [c.store])).rows[0];
                if (!check || check.available_slots <= 0) return interaction.editReply({ content: '❌ Sorry, this store just ran out of slots.', components: [backToStoreRow()] });

                const requestId = await nextCommissionId(c.store);
                await pool.query(
                    `INSERT INTO active_commissions (request_id,user_id,store,status,mesh_quantity,mesh_description,mesh_changes,mesh_references,rigging_confirmed,payment_method,texturization_requested,texturization_type,texturization_quantity,selected_patterns,selected_colors,print_references)
                     VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                    [requestId, uid, c.store, c.mesh_quantity, c.mesh_description, c.mesh_changes, c.mesh_references || [], c.rigging_confirmed, c.payment_method,
                    c.texturization_requested || false, c.texturization_type || null, c.texturization_quantity || 0, c.selected_patterns || [], c.selected_colors || [], c.print_references || []]);
                await takeSlot(c.store);

                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [requestId])).rows[0];
                const user = await client.users.fetch(uid).catch(() => null);
                await sendCommissionToStore(c.store, [commissionEmbed(comm, user, '🎨 NEW MESH COMMISSION')], adminActionRows(requestId));

                delete clientSession[uid];
                await logCommission(uid, `Commission ${requestId} submitted`, { requestId, store: c.store, username: interaction.user.username });

                return interaction.editReply({
                    embeds: [new EmbedBuilder()
                        .setTitle('✅ Commission Submitted!')
                        .setDescription(`Your commission \`${requestId}\` was sent to \`${storeLabel(c.store)}\`.`)
                        .addFields(
                            { name: '📋 Status', value: 'Awaiting administrator review', inline: false },
                            { name: '⏱️ Next step', value: 'You will be notified via DM as soon as there is a response.', inline: false }
                        ).setColor(0x2ecc71).setTimestamp()],
                    components: [backToStoreRow()]
                });
            }

            // ==================================================================
            // === ADMIN: ACCEPT / DECLINE / DETAILS ============================
            // ==================================================================
            if (isBtn && id.startsWith('admin_commission_accept_')) {
                await interaction.deferReply(EP);
                const requestId = id.replace('admin_commission_accept_', '');
                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [requestId])).rows[0];
                if (!comm) return interaction.editReply({ content: '❌ Commission not found.' });
                if (comm.status !== 'PENDING') return interaction.editReply({ content: `⚠️ Already processed (${comm.status}).` });
                await pool.query(`UPDATE active_commissions SET status='ACCEPTED', reviewed_by=$1, updated_at=NOW() WHERE request_id=$2`, [uid, requestId]);
                await dmUser(comm.user_id, {
                    embeds: [new EmbedBuilder().setTitle('✅ Commission Accepted!')
                        .setDescription(`Your commission \`${requestId}\` was accepted by \`${storeLabel(comm.store)}\`.`)
                        .addFields({ name: '📋 Status', value: 'An administrator will contact you shortly to finalize details and payment.' })
                        .setColor(0x2ecc71).setTimestamp()]
                });
                await logCommission(comm.user_id, `Commission ${requestId} ACCEPTED`, { requestId, store: comm.store });
                try { await interaction.message?.edit({ components: [] }); } catch { }
                return interaction.editReply({ content: `✅ \`${requestId}\` accepted. Client notified.` });
            }

            if (isBtn && id.startsWith('admin_commission_decline_')) {
                await interaction.deferReply(EP);
                const requestId = id.replace('admin_commission_decline_', '');
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle(`❌ Decline ${requestId}`).setDescription('Select the reason:').setColor(0xe74c3c)],
                    components: [row(
                        btn(`admin_decline_complex_${requestId}`, '🔧 Mesh too complex', ButtonStyle.Danger),
                        btn(`admin_decline_busy_${requestId}`, '⏰ No time available', ButtonStyle.Danger),
                        btn(`admin_decline_custom_${requestId}`, '✏️ Other reason', ButtonStyle.Secondary)
                    )]
                });
            }

            if (isBtn && (id.startsWith('admin_decline_complex_') || id.startsWith('admin_decline_busy_'))) {
                await interaction.deferReply(EP);
                const isComplex = id.startsWith('admin_decline_complex_');
                const requestId = id.replace(isComplex ? 'admin_decline_complex_' : 'admin_decline_busy_', '');
                await processCommissionDecline(requestId, isComplex ? 'complex' : 'busy', null, uid);
                return interaction.editReply({ content: `❌ \`${requestId}\` declined. Client notified.` });
            }

            if (isBtn && id.startsWith('admin_decline_custom_')) {
                const requestId = id.replace('admin_decline_custom_', '');
                return interaction.showModal(new ModalBuilder().setCustomId(`admin_decline_custom_modal_${requestId}`).setTitle('Decline Reason')
                    .addComponents(row(new TextInputBuilder().setCustomId('reason').setLabel('Describe the reason').setStyle(TextInputStyle.Paragraph).setRequired(true))));
            }

            if (isMod && id.startsWith('admin_decline_custom_modal_')) {
                await interaction.deferReply(EP);
                const requestId = id.replace('admin_decline_custom_modal_', '');
                await processCommissionDecline(requestId, 'custom', interaction.fields.getTextInputValue('reason'), uid);
                return interaction.editReply({ content: `❌ \`${requestId}\` declined. Client notified.` });
            }

            if (isBtn && id.startsWith('admin_commission_details_')) {
                await interaction.deferReply(EP);
                const requestId = id.replace('admin_commission_details_', '');
                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [requestId])).rows[0];
                if (!comm) return interaction.editReply({ content: '❌ Commission not found.' });
                const user = await client.users.fetch(comm.user_id).catch(() => null);
                const components = comm.status === 'PENDING' ? adminActionRows(requestId) : [];
                return interaction.editReply({ embeds: [commissionEmbed(comm, user, `🔍 Full Details — ${requestId}`)], components });
            }

            // ==================================================================
            // === TRANSFERÊNCIA =================================================
            // ==================================================================
            if (isBtn && id.startsWith('admin_commission_transfer_')) {
                await interaction.deferReply(EP);
                const requestId = id.replace('admin_commission_transfer_', '');
                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [requestId])).rows[0];
                if (!comm) return interaction.editReply({ content: '❌ Commission not found.' });
                if (comm.status !== 'PENDING') return interaction.editReply({ content: `⚠️ Already processed (${comm.status}).` });
                adminWizard[uid] = { type: 'commission_transfer', requestId, currentStore: comm.store };
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle(`🔁 Transfer ${requestId}`)
                        .setDescription('**Step 1/3** — Why are you giving up this commission?\n*(This reason will be shown to the client.)*').setColor(0xf39c12)],
                    components: [row(
                        btn(`comm_tr_reason_${requestId}_busy`, '⏰ No time', ButtonStyle.Secondary),
                        btn(`comm_tr_reason_${requestId}_complex`, '🔧 Too complex', ButtonStyle.Secondary),
                        btn(`comm_tr_reason_${requestId}_custom`, '✏️ Other', ButtonStyle.Primary)
                    )]
                });
            }

            if (isBtn && id.startsWith('comm_tr_reason_')) {
                const rest = id.replace('comm_tr_reason_', '');
                const i = rest.lastIndexOf('_');
                const requestId = rest.substring(0, i), type = rest.substring(i + 1);
                if (type === 'custom') {
                    return interaction.showModal(new ModalBuilder().setCustomId('comm_tr_reason_modal').setTitle('Transfer Reason')
                        .addComponents(row(new TextInputBuilder().setCustomId('text').setLabel('Why are you transferring?').setStyle(TextInputStyle.Paragraph).setRequired(true))));
                }
                await interaction.deferReply(EP);
                const w = adminWizard[uid];
                if (!w || w.type !== 'commission_transfer') return interaction.editReply({ content: '❌ Session expired.' });
                w.reasonType = type; w.reasonText = null;
                return transferPickStore(interaction, w);
            }

            if (isMod && id === 'comm_tr_reason_modal') {
                await interaction.deferReply(EP);
                const w = adminWizard[uid];
                if (!w || w.type !== 'commission_transfer') return interaction.editReply({ content: '❌ Session expired.' });
                w.reasonType = 'custom';
                w.reasonText = interaction.fields.getTextInputValue('text');
                return transferPickStore(interaction, w);
            }

            async function transferPickStore(interaction, w) {
                const targets = STORES.filter(s => s !== w.currentStore);
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle(`🔁 Transfer ${w.requestId}`)
                        .setDescription(`**Step 2/3** — Which store should receive this commission?\nReason: ${reasonText(w.reasonType, w.reasonText)}`).setColor(0xf39c12)],
                    components: [row(...targets.map(s => btn(`comm_tr_target_${w.requestId}_${s}`, `🛒 ${storeLabel(s)}`, ButtonStyle.Primary)))]
                });
            }

            if (isBtn && id.startsWith('comm_tr_target_')) {
                await interaction.deferReply(EP);
                const rest = id.replace('comm_tr_target_', '');
                const m = rest.match(/^([A-Z]+-C\d+)_(.+)$/);
                if (!m) return interaction.editReply({ content: '❌ Invalid data.' });
                const w = adminWizard[uid];
                if (!w || w.type !== 'commission_transfer') return interaction.editReply({ content: '❌ Session expired.' });
                w.requestId = m[1];
                w.targetStore = m[2];
                return interaction.editReply({
                    embeds: [new EmbedBuilder().setTitle(`🔁 Transfer ${w.requestId}`)
                        .setDescription(`**Step 3/3** — If **${storeLabel(w.targetStore)}** declines, what should the client be told?`).setColor(0xf39c12)],
                    components: [row(
                        btn(`comm_tr_fb_${w.requestId}_busy`, '⏰ No time', ButtonStyle.Secondary),
                        btn(`comm_tr_fb_${w.requestId}_complex`, '🔧 Too complex', ButtonStyle.Secondary),
                        btn(`comm_tr_fb_${w.requestId}_custom`, '✏️ Other', ButtonStyle.Primary)
                    )]
                });
            }

            if (isBtn && id.startsWith('comm_tr_fb_')) {
                const rest = id.replace('comm_tr_fb_', '');
                const i = rest.lastIndexOf('_');
                const requestId = rest.substring(0, i), type = rest.substring(i + 1);
                if (type === 'custom') {
                    return interaction.showModal(new ModalBuilder().setCustomId('comm_tr_fb_modal').setTitle('Fallback Reason')
                        .addComponents(row(new TextInputBuilder().setCustomId('text').setLabel('Message if the new store declines').setStyle(TextInputStyle.Paragraph).setRequired(true))));
                }
                await interaction.deferReply(EP);
                const w = adminWizard[uid];
                if (!w || w.type !== 'commission_transfer') return interaction.editReply({ content: '❌ Session expired.' });
                w.fbType = type; w.fbText = null;
                return executeTransfer(interaction, w);
            }

            if (isMod && id === 'comm_tr_fb_modal') {
                await interaction.deferReply(EP);
                const w = adminWizard[uid];
                if (!w || w.type !== 'commission_transfer') return interaction.editReply({ content: '❌ Session expired.' });
                w.fbType = 'custom';
                w.fbText = interaction.fields.getTextInputValue('text');
                return executeTransfer(interaction, w);
            }

            async function executeTransfer(interaction, w) {
                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [w.requestId])).rows[0];
                if (!comm) return interaction.editReply({ content: '❌ Commission not found.' });

                await pool.query(
                    `UPDATE active_commissions SET transfer_target_store=$1, transfer_reason_type=$2, transfer_reason_text=$3, transfer_fallback_type=$4, transfer_fallback_text=$5, transfer_status='AWAITING_TARGET', transferred_by=$6, updated_at=NOW() WHERE request_id=$7`,
                    [w.targetStore, w.reasonType, w.reasonText, w.fbType, w.fbText, uid, w.requestId]);

                const fresh = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [w.requestId])).rows[0];
                const user = await client.users.fetch(comm.user_id).catch(() => null);
                const e = commissionEmbed(fresh, user, `🔁 TRANSFER REQUEST — ${w.requestId}`);
                e.addFields({ name: '📩 Coming from', value: `${storeLabel(comm.store)} says: ${reasonText(w.reasonType, w.reasonText)}`, inline: false });

                await sendCommissionToStore(w.targetStore, [e], [
                    row(
                        btn(`comm_tr_accept_${w.requestId}`, '✅ Accept transfer', ButtonStyle.Success),
                        btn(`comm_tr_decline_${w.requestId}`, '❌ Decline transfer', ButtonStyle.Danger)
                    ),
                    row(btn(`admin_commission_details_${w.requestId}`, '🔍 View full details', ButtonStyle.Secondary))
                ]);

                await logCommission(comm.user_id, `Transfer requested: ${w.requestId} → ${storeLabel(w.targetStore)}`, { requestId: w.requestId, store: comm.store });
                delete adminWizard[uid];
                return interaction.editReply({ content: `🔁 Transfer request sent to **${storeLabel(w.targetStore)}**.\nYou will be notified about their decision.` });
            }

            if (isBtn && id.startsWith('comm_tr_decline_')) {
                await interaction.deferReply(EP);
                const requestId = id.replace('comm_tr_decline_', '');
                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [requestId])).rows[0];
                if (!comm) return interaction.editReply({ content: '❌ Not found.' });
                if (comm.transfer_status !== 'AWAITING_TARGET') return interaction.editReply({ content: '⚠️ This transfer is no longer pending.' });
                await processCommissionDecline(requestId, comm.transfer_fallback_type || 'busy', comm.transfer_fallback_text, uid);
                await dmUser(comm.transferred_by, { content: `❌ **${storeLabel(comm.transfer_target_store)}** declined the transfer of \`${requestId}\`. The client was notified with the reason you selected.` });
                try { await interaction.message?.edit({ components: [] }); } catch { }
                return interaction.editReply({ content: `❌ Transfer declined. Client notified.` });
            }

            if (isBtn && id.startsWith('comm_tr_accept_')) {
                await interaction.deferReply(EP);
                const requestId = id.replace('comm_tr_accept_', '');
                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [requestId])).rows[0];
                if (!comm) return interaction.editReply({ content: '❌ Not found.' });
                if (comm.transfer_status !== 'AWAITING_TARGET') return interaction.editReply({ content: '⚠️ This transfer is no longer pending.' });

                await pool.query(`UPDATE active_commissions SET transfer_status='AWAITING_CLIENT', transfer_expires_at = NOW() + ($1 || ' hours')::INTERVAL, updated_at=NOW() WHERE request_id=$2`, [TRANSFER_DEADLINE_HOURS, requestId]);
                const expiresTs = Math.floor(Date.now() / 1000) + TRANSFER_DEADLINE_HOURS * 3600;
                const contact = COMMISSION_CONTACTS[comm.transfer_target_store];

                await dmUser(comm.user_id, {
                    embeds: [new EmbedBuilder()
                        .setTitle('🔁 Commission Transfer Proposal')
                        .setDescription(
                            `Your commission \`${requestId}\` was being handled by **${storeLabel(comm.store)}**.\n\n` +
                            `**Why they can't continue:**\n${reasonText(comm.transfer_reason_type, comm.transfer_reason_text)}\n\n` +
                            `They transferred your request to **${storeLabel(comm.transfer_target_store)}**, and that store **already accepted** it! ✅\n\n` +
                            `Do you accept the transfer?\n⏰ You have until <t:${expiresTs}:R> to answer.`
                        ).setColor(0xf39c12).setTimestamp()],
                    components: [row(
                        btn(`comm_tr_cli_yes_${requestId}`, '✅ Yes, I accept', ButtonStyle.Success),
                        btn(`comm_tr_cli_no_${requestId}`, '❌ No, cancel it', ButtonStyle.Danger)
                    )]
                });
                try { await interaction.message?.edit({ components: [] }); } catch { }
                await logCommission(comm.user_id, `Transfer accepted by ${storeLabel(comm.transfer_target_store)}, awaiting client`, { requestId, store: comm.store });
                return interaction.editReply({ content: `✅ Transfer accepted! The client has **${TRANSFER_DEADLINE_HOURS}h** to confirm.\nContact for this store: <@${contact.id}>` });
            }

            if (isBtn && id.startsWith('comm_tr_cli_no_')) {
                await interaction.deferReply(EP);
                const requestId = id.replace('comm_tr_cli_no_', '');
                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [requestId])).rows[0];
                if (!comm || comm.transfer_status !== 'AWAITING_CLIENT') return interaction.editReply({ content: '⚠️ This proposal is no longer valid.' });
                await processCommissionDecline(requestId, 'custom', 'You chose not to accept the transfer to another store.', uid);
                if (comm.transferred_by) await dmUser(comm.transferred_by, { content: `❌ The client declined the transfer of \`${requestId}\`.` });
                await dmUser(comm.user_id, { content: `❌ Your commission \`${requestId}\` was cancelled as requested.`, components: [backToStoreRow()] });
                return interaction.editReply({ content: '❌ Transfer declined. Your commission was cancelled.', components: [backToStoreRow()] });
            }

            if (isBtn && id.startsWith('comm_tr_cli_yes_')) {
                await interaction.deferReply(EP);
                const requestId = id.replace('comm_tr_cli_yes_', '');
                const comm = (await pool.query(`SELECT * FROM active_commissions WHERE request_id=$1`, [requestId])).rows[0];
                if (!comm || comm.transfer_status !== 'AWAITING_CLIENT') return interaction.editReply({ content: '⚠️ This proposal expired or was already handled.' });

                const newStore = comm.transfer_target_store;
                const newId = await nextCommissionId(newStore);

                await pool.query(
                    `INSERT INTO active_commissions (request_id,user_id,store,status,mesh_quantity,mesh_description,mesh_changes,mesh_references,rigging_confirmed,payment_method,texturization_requested,texturization_type,texturization_quantity,selected_patterns,selected_colors,print_references,reviewed_by,transfer_from_store,transfer_from_request_id,transfer_reason_type,transfer_reason_text)
                     VALUES ($1,$2,$3,'ACCEPTED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                    [newId, comm.user_id, newStore, comm.mesh_quantity, comm.mesh_description, comm.mesh_changes, comm.mesh_references, comm.rigging_confirmed,
                    comm.payment_method, comm.texturization_requested, comm.texturization_type, comm.texturization_quantity, comm.selected_patterns,
                    comm.selected_colors, comm.print_references, comm.transferred_by, comm.store, requestId, comm.transfer_reason_type, comm.transfer_reason_text]);

                await archiveCommission(comm, uid, `Transferred to ${newStore} as ${newId}`);
                await pool.query(`DELETE FROM active_commissions WHERE request_id=$1`, [requestId]);
                await freeSlot(comm.store);
                await takeSlot(newStore);

                const contact = COMMISSION_CONTACTS[newStore];
                await dmUser(comm.user_id, {
                    embeds: [new EmbedBuilder()
                        .setTitle('✅ Transfer Confirmed!')
                        .setDescription(
                            `Your commission is now officially with **${storeLabel(newStore)}**!\n\n` +
                            `🔢 **Your new request code:**\n\`${requestId}\` ➜ \`${newId}\`\n\n` +
                            `👤 **Who will contact you:**\n<@${contact.id}>\nUsername: **@${contact.username}**\nID: \`${contact.id}\`\n\n` +
                            `Keep this new code to track your commission.`
                        ).setColor(0x2ecc71).setTimestamp()],
                    components: [backToStoreRow()]
                });
                await sendCommissionToStore(newStore, [new EmbedBuilder()
                    .setTitle('🎉 Commission officially yours!')
                    .setDescription(`The client accepted the transfer.\nNew code: \`${newId}\`\nClient: <@${comm.user_id}>`)
                    .setColor(0x2ecc71)], [row(btn(`admin_commission_details_${newId}`, '🔍 View details', ButtonStyle.Primary))]);
                if (comm.transferred_by) await dmUser(comm.transferred_by, { content: `✅ The client accepted the transfer. \`${requestId}\` is now \`${newId}\` at ${storeLabel(newStore)}. Your slot was released.` });

                await logCommission(comm.user_id, `Transfer confirmed: ${requestId} → ${newId} (${storeLabel(newStore)})`, { requestId: newId, store: newStore });
                return interaction.editReply({ content: `✅ Transfer confirmed! Your new code is \`${newId}\`. Check your DM for the contact details.` });
            }

        } catch (err) {
            if (err && (err.code === 10062 || err.code === 10008)) return;
            console.error('[COMMISSION ERROR]', err);
            try {
                if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Internal error.', ...EP });
                else await interaction.editReply({ content: '❌ Internal error. Please try again.' });
            } catch { }
        }
    });

    // ==========================================================================
    // === JOB: EXPIRAR TRANSFERÊNCIAS (24h) ====================================
    // ==========================================================================
    setInterval(async () => {
        try {
            const expired = await pool.query(`SELECT * FROM active_commissions WHERE transfer_status='AWAITING_CLIENT' AND transfer_expires_at < NOW()`);
            for (const comm of expired.rows) {
                await processCommissionDecline(comm.request_id, 'custom', 'You did not respond to the transfer proposal within 24 hours.', 'SYSTEM');
                if (comm.transferred_by) await dmUser(comm.transferred_by, { content: `⏰ The client did not answer the transfer of \`${comm.request_id}\` within 24h. It was cancelled and your slot released.` });
            }
        } catch (e) { /* silent */ }
    }, 5 * 60 * 1000);

    console.log('✅ [COMMISSION] Módulo inicializado (comissões + suggestions)');
};
