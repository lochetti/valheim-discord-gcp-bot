import { Storage } from "@google-cloud/storage";

function getStorage() {
  return new Storage({ projectId: process.env.PROJECT_ID });
}

export async function waitForFlag(
  path: string,
  timeoutMs: number,
  intervalMs = 10_000
): Promise<void> {
  const bucket = getStorage().bucket(process.env.BUCKET_NAME!);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [exists] = await bucket.file(path).exists();
    if (exists) return;
    const remaining = Math.round((deadline - Date.now()) / 1000);
    console.log(`[storage] waiting for ${path} (${remaining}s left)...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timeout waiting for flag: ${path}`);
}

export async function deleteFlag(path: string): Promise<void> {
  const bucket = getStorage().bucket(process.env.BUCKET_NAME!);
  await bucket.file(path).delete({ ignoreNotFound: true });
}
