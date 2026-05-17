import type { ChatInputCommandInteraction } from "discord.js";
import { deleteVM, getVM } from "../gcp/vm.ts";
import { deleteFlag, waitForFlag } from "../gcp/storage.ts";

export async function handleStop(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.deferReply();

  try {
    console.log("[stop] checking for running VM...");
    const vm = await getVM(process.env.VM_NAME!);
    if (!vm) {
      console.log("[stop] no VM found");
      await interaction.editReply("⚠️ No server is currently running.");
      return;
    }

    console.log(`[stop] VM found at ${vm.ip}, sending shutdown signal...`);
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
      console.log("[stop] shutdown signal accepted (202)");
    } catch (e: any) {
      console.error("[stop] could not reach shutdown endpoint:", e.message);
      await interaction.editReply(
        `❌ Could not reach VM shutdown endpoint: ${e.message}. Check GCP console.`
      );
      return;
    }

    console.log("[stop] waiting for done flag...");
    await interaction.editReply("🟡 Saving world & uploading to GCS...");

    try {
      await waitForFlag(`status/${process.env.VM_NAME}/done.flag`, 5 * 60 * 1_000);
    } catch {
      console.log("[stop] timed out waiting for done flag");
      await interaction.editReply(
        "❌ Timed out waiting for server to stop. VM may still be running. Check GCP console."
      );
      return;
    }

    console.log("[stop] done flag found, deleting VM...");
    await deleteFlag(`status/${process.env.VM_NAME}/done.flag`);

    await interaction.editReply("🟡 Deleting VM...");
    await deleteVM(process.env.VM_NAME!);

    console.log("[stop] VM deleted");
    await interaction.editReply("✅ Server stopped and VM deleted. World saved.");
  } catch (e: any) {
    console.error("[stop] unexpected error:", e);
    await interaction.editReply(`❌ Unexpected error: ${e.message}`);
  }
}
