import type { ChatInputCommandInteraction } from "discord.js";
import { deleteVM, getVM } from "../gcp/vm.ts";
import { deleteFlag, waitForFlag } from "../gcp/storage.ts";

export async function handleStop(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.deferReply();

  try {
    const vm = await getVM(process.env.VM_NAME!);
    if (!vm) {
      await interaction.editReply("⚠️ No server is currently running.");
      return;
    }

    await interaction.editReply("🟡 Sending shutdown signal...");

    try {
      const res = await fetch(
        `http://${vm.ip}:${process.env.SHUTDOWN_PORT}/shutdown`,
        {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e: any) {
      await interaction.editReply(
        `❌ Could not reach VM shutdown endpoint: ${e.message}. Check GCP console.`
      );
      return;
    }

    await interaction.editReply("🟡 Saving world & uploading to GCS...");

    try {
      await waitForFlag("status/done.flag", 5 * 60 * 1_000);
    } catch {
      await interaction.editReply(
        "❌ Timed out waiting for server to stop. VM may still be running. Check GCP console."
      );
      return;
    }

    await deleteFlag("status/done.flag");

    await interaction.editReply("🟡 Deleting VM...");
    await deleteVM(process.env.VM_NAME!);

    await interaction.editReply("✅ Server stopped and VM deleted. World saved.");
  } catch (e: any) {
    await interaction.editReply(`❌ Unexpected error: ${e.message}`);
  }
}
