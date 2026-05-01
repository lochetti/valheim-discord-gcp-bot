import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
} from "discord.js";
import { handleStart } from "./commands/start.ts";
import { handleStop } from "./commands/stop.ts";

const COMMANDS = [
  {
    name: "valheim",
    description: "Manage the Valheim dedicated server",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "start",
        description: "Start the Valheim server (creates a GCP VM)",
      },
      {
        type: 1, // SUB_COMMAND
        name: "stop",
        description:
          "Stop the Valheim server (saves world, deletes GCP VM)",
      },
    ],
  },
];

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(
    process.env.DISCORD_TOKEN!
  );
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_APP_ID!,
      process.env.DISCORD_GUILD_ID!
    ),
    { body: COMMANDS }
  );
  console.log("[bot] Slash commands registered to guild");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "valheim") return;

  const sub = interaction.options.getSubcommand();
  const i = interaction as ChatInputCommandInteraction;

  if (sub === "start") await handleStart(i);
  else if (sub === "stop") await handleStop(i);
});

await registerCommands();
await client.login(process.env.DISCORD_TOKEN!);
