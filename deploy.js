require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
    new SlashCommandBuilder()
        .setName("painel")
        .setDescription("Abre o painel de vendas (Público)"),
    
    new SlashCommandBuilder()
        .setName("produto")
        .setDescription("Gerenciar produtos")
        .addSubcommand(sub => sub.setName("criar").setDescription("Criar produto"))
        .addSubcommand(sub => sub.setName("editar").setDescription("Editar produto")),
    
    new SlashCommandBuilder()
        .setName("lindens")
        .setDescription("Atualiza cotação Linden (Admin)"),
    
    new SlashCommandBuilder()
        .setName("fila")
        .setDescription("Gerenciar filas (Admin)"),
    
    new SlashCommandBuilder()
        .setName("credits")
        .setDescription("Gerenciar créditos rápido (Admin)"),
    
    new SlashCommandBuilder()
        .setName("admin-cliente")
        .setDescription("Painel completo de gestão de cliente (Admin)"),
    
    // NOVO COMANDO RELATORIO
    new SlashCommandBuilder()
        .setName("relatorio")
        .setDescription("Gera relatórios de vendas (Diário, Mensal, Anual)"),

    new SlashCommandBuilder()
        .setName("dev")
        .setDescription("Painel de Desenvolvedor (Manutenção, Logs, CSV)")
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log("Registrando comandos...");
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands.map(cmd => cmd.toJSON()) }
        );
        console.log("✅ Comandos registrados!");
    } catch (error) {
        console.error("❌ Erro:", error);
    }
})();