import type { ChatInputCommandInteraction } from "discord.js";
import { createVM, getVM } from "../gcp/vm.ts";
import { deleteFlag, waitForFlag } from "../gcp/storage.ts";

export async function handleStart(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.deferReply();

  try {
    console.log("[start] checking for existing VM...");
    const existing = await getVM(process.env.VM_NAME!);
    if (existing) {
      console.log(`[start] VM already running at ${existing.ip}`);
      await interaction.editReply(
        `⚠️ Server already running! Connect to: \`${existing.ip}:2456\``
      );
      return;
    }

    console.log("[start] creating VM...");
    await interaction.editReply("🟡 Creating VM...");
    await createVM(process.env.VM_NAME!);
    console.log("[start] VM created, waiting for ready flag...");

    await interaction.editReply(
      "🟡 VM created. Waiting for Valheim to start..."
    );

    try {
      await waitForFlag("status/ready.flag", 10 * 60 * 1_000);
    } catch {
      console.log("[start] timed out waiting for ready flag");
      await interaction.editReply(
        "❌ Timed out waiting for Valheim to start. Check the GCP console."
      );
      return;
    }

    console.log("[start] ready flag found, fetching VM IP...");
    await deleteFlag("status/ready.flag");

    const vm = await getVM(process.env.VM_NAME!);
    console.log(`[start] done, IP: ${vm?.ip}`);
    await interaction.editReply(
      `✅ Server is up! Connect to: \`${vm?.ip ?? "unknown"}:2456\``
    );
  } catch (e: any) {
    console.error("[start] unexpected error:", e);
    await interaction.editReply(`❌ Unexpected error: ${e.message}`);
  }
}
