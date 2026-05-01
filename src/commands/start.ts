import type { ChatInputCommandInteraction } from "discord.js";
import { createVM, getVM } from "../gcp/vm.ts";
import { deleteFlag, waitForFlag } from "../gcp/storage.ts";

export async function handleStart(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.deferReply();

  try {
    const existing = await getVM(process.env.VM_NAME!);
    if (existing) {
      await interaction.editReply(
        `⚠️ Server already running! Connect to: \`${existing.ip}:2456\``
      );
      return;
    }

    await interaction.editReply("🟡 Creating VM...");
    await createVM(process.env.VM_NAME!);

    await interaction.editReply(
      "🟡 VM created. Waiting for Valheim to start..."
    );

    try {
      await waitForFlag("status/ready.flag", 10 * 60 * 1_000);
    } catch {
      await interaction.editReply(
        "❌ Timed out waiting for Valheim to start. Check the GCP console."
      );
      return;
    }

    await deleteFlag("status/ready.flag");

    const vm = await getVM(process.env.VM_NAME!);
    await interaction.editReply(
      `✅ Server is up! Connect to: \`${vm?.ip ?? "unknown"}:2456\``
    );
  } catch (e: any) {
    await interaction.editReply(`❌ Unexpected error: ${e.message}`);
  }
}
