# Valheim Discord Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Discord bot that creates and destroys a GCP VM on demand to host a Valheim dedicated server, persisting the world save in GCS between sessions.

**Architecture:** Single long-running Bun process using discord.js WebSocket gateway. Slash commands defer the reply immediately, then drive async polling loops that edit the same Discord message at each status change. VM state is always queried live from GCP — no local state file.

**Tech Stack:** Bun, TypeScript (strict), discord.js v14, @google-cloud/compute v4, @google-cloud/storage v7, Python 3 (VM-side shutdown server), bash (VM-side scripts)

---

## File Map

| File | Purpose |
|---|---|
| `src/index.ts` | Bot entry: register slash commands, start gateway, route interactions |
| `src/commands/start.ts` | `/valheim start` handler — create VM, poll GCS for ready flag, report IP |
| `src/commands/stop.ts` | `/valheim stop` handler — call VM shutdown endpoint, poll GCS for done flag, delete VM |
| `src/gcp/vm.ts` | `getVM()`, `createVM()`, `deleteVM()` wrapping @google-cloud/compute |
| `src/gcp/storage.ts` | `waitForFlag()`, `deleteFlag()` wrapping @google-cloud/storage |
| `src/gcp/vm.test.ts` | Unit tests for vm.ts |
| `src/gcp/storage.test.ts` | Unit tests for storage.ts |
| `src/commands/start.test.ts` | Unit tests for handleStart |
| `src/commands/stop.test.ts` | Unit tests for handleStop |
| `scripts/startup.sh` | Injected as VM metadata; downloads save, starts Valheim, writes ready.flag |
| `scripts/stop.sh` | Baked into image; SIGTERMs Valheim, uploads save, writes done.flag |
| `scripts/shutdown-server.py` | Baked into image; HTTP server on :8080, POST /shutdown triggers stop.sh |
| `.env.example` | Template for all required env vars |
| `README.md` | Setup guide, custom image instructions, run instructions |

---

## Task 1: Project Setup

**Files:**
- Modify: `package.json`
- Modify: `index.ts` (delete — entry moves to `src/index.ts`)
- Create: `.env.example`
- Create: `src/` directory tree

- [ ] **Step 1: Update package.json**

Replace the entire file with:

```json
{
  "name": "gserver",
  "module": "src/index.ts",
  "type": "module",
  "private": true,
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --hot src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "discord.js": "^14.16.3",
    "@google-cloud/compute": "^4.7.0",
    "@google-cloud/storage": "^7.14.0"
  },
  "devDependencies": {
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
bun install
```

Expected: `bun.lock` updates, `node_modules` gains discord.js, @google-cloud/compute, @google-cloud/storage.

- [ ] **Step 3: Create directory structure**

```bash
mkdir -p src/commands src/gcp scripts
```

- [ ] **Step 4: Create `.env.example`**

```
DISCORD_TOKEN=your_discord_bot_token
DISCORD_APP_ID=your_discord_application_id
DISCORD_GUILD_ID=your_discord_guild_id
PROJECT_ID=your_gcp_project_id
ZONE=southamerica-east1-b
BUCKET_NAME=your_gcs_bucket_name
IMAGE_NAME=valheim-base-v1
MACHINE_TYPE=e2-standard-2
VM_NAME=valheim-server
SHUTDOWN_PORT=8080
```

- [ ] **Step 5: Replace placeholder index.ts with a stub that will be filled in Task 6**

Replace contents of `index.ts` (project root) with nothing — this file is no longer the entry point. Delete it:

```bash
rm index.ts
```

- [ ] **Step 6: Create empty entry point placeholder**

Create `src/index.ts` with:

```typescript
// implemented in Task 6
```

- [ ] **Step 7: Verify bun test runs (no tests yet)**

```bash
bun test
```

Expected output: `0 tests` or `No test files found`. No errors.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock .env.example src/index.ts
git commit -m "chore: set up project structure and install dependencies"
```

---

## Task 2: GCS Storage Helpers (`src/gcp/storage.ts`)

**Files:**
- Create: `src/gcp/storage.ts`
- Create: `src/gcp/storage.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/gcp/storage.test.ts`:

```typescript
import { mock, expect, test, beforeEach } from "bun:test";

process.env.PROJECT_ID = "test-project";
process.env.BUCKET_NAME = "test-bucket";

// Mocks must be declared before dynamic import of module under test
const mockExists = mock(async (): Promise<[boolean]> => [false]);
const mockDelete = mock(async (): Promise<unknown[]> => []);

mock.module("@google-cloud/storage", () => ({
  Storage: class {
    bucket(_name: string) {
      return {
        file: (_path: string) => ({
          exists: mockExists,
          delete: mockDelete,
        }),
      };
    }
  },
}));

const { waitForFlag, deleteFlag } = await import("./storage.ts");

beforeEach(() => {
  mockExists.mockReset();
  mockDelete.mockReset();
  mockExists.mockImplementation(async () => [false]);
  mockDelete.mockImplementation(async () => []);
});

test("waitForFlag resolves immediately when file exists on first poll", async () => {
  mockExists.mockImplementation(async () => [true]);
  await expect(waitForFlag("status/ready.flag", 5_000)).resolves.toBeUndefined();
  expect(mockExists).toHaveBeenCalledTimes(1);
});

test("waitForFlag rejects with timeout error when file never appears", async () => {
  mockExists.mockImplementation(async () => [false]);
  await expect(waitForFlag("status/ready.flag", 100, 40)).rejects.toThrow(
    "Timeout waiting for flag: status/ready.flag"
  );
});

test("waitForFlag resolves after file appears on second poll", async () => {
  let calls = 0;
  mockExists.mockImplementation(async () => {
    calls++;
    return [calls >= 2];
  });
  await expect(waitForFlag("status/ready.flag", 5_000, 10)).resolves.toBeUndefined();
  expect(mockExists).toHaveBeenCalledTimes(2);
});

test("deleteFlag calls delete on the file at the given path", async () => {
  await deleteFlag("status/ready.flag");
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/gcp/storage.test.ts
```

Expected: 4 failures — `Cannot find module './storage'` or similar.

- [ ] **Step 3: Implement `src/gcp/storage.ts`**

```typescript
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
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Timeout waiting for flag: ${path}`);
}

export async function deleteFlag(path: string): Promise<void> {
  const bucket = getStorage().bucket(process.env.BUCKET_NAME!);
  await bucket.file(path).delete({ ignoreNotFound: true });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/gcp/storage.test.ts
```

Expected: `4 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/gcp/storage.ts src/gcp/storage.test.ts
git commit -m "feat: add GCS flag polling helpers (waitForFlag, deleteFlag)"
```

---

## Task 3: GCP VM Helpers (`src/gcp/vm.ts`)

**Files:**
- Create: `src/gcp/vm.ts`
- Create: `src/gcp/vm.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/gcp/vm.test.ts`:

```typescript
import { mock, expect, test, beforeEach } from "bun:test";

process.env.PROJECT_ID = "test-project";
process.env.ZONE = "southamerica-east1-b";
process.env.BUCKET_NAME = "test-bucket";
process.env.IMAGE_NAME = "valheim-base-v1";
process.env.MACHINE_TYPE = "e2-standard-2";

const mockInstanceGet = mock(async () => [
  {
    status: "RUNNING",
    networkInterfaces: [{ accessConfigs: [{ natIP: "1.2.3.4" }] }],
  },
]);
const mockInsert = mock(async () => [{ name: "operation-insert-123" }]);
const mockInstanceDelete = mock(async () => [{ name: "operation-delete-456" }]);
const mockOpsGet = mock(async () => [{ status: "DONE", error: null }]);

mock.module("@google-cloud/compute", () => ({
  InstancesClient: class {
    get = mockInstanceGet;
    insert = mockInsert;
    delete = mockInstanceDelete;
  },
  ZoneOperationsClient: class {
    get = mockOpsGet;
  },
}));

mock.module("node:fs", () => ({
  readFileSync: () => "#!/bin/bash\necho startup",
}));

const { getVM, createVM, deleteVM } = await import("./vm.ts");

beforeEach(() => {
  mockInstanceGet.mockReset();
  mockInsert.mockReset();
  mockInstanceDelete.mockReset();
  mockOpsGet.mockReset();
  mockOpsGet.mockImplementation(async () => [{ status: "DONE", error: null }]);
});

test("getVM returns VMInfo when instance exists and is RUNNING", async () => {
  mockInstanceGet.mockImplementation(async () => [
    {
      status: "RUNNING",
      networkInterfaces: [{ accessConfigs: [{ natIP: "1.2.3.4" }] }],
    },
  ]);
  const result = await getVM("valheim-server");
  expect(result).toEqual({ status: "RUNNING", ip: "1.2.3.4" });
});

test("getVM returns null when instance not found (gRPC NOT_FOUND code 5)", async () => {
  mockInstanceGet.mockImplementation(async () => {
    const err = new Error("Instance not found") as any;
    err.code = 5;
    throw err;
  });
  const result = await getVM("valheim-server");
  expect(result).toBeNull();
});

test("getVM returns null when instance not found (HTTP 404)", async () => {
  mockInstanceGet.mockImplementation(async () => {
    const err = new Error("Not found") as any;
    err.code = 404;
    throw err;
  });
  const result = await getVM("valheim-server");
  expect(result).toBeNull();
});

test("getVM re-throws unexpected errors", async () => {
  mockInstanceGet.mockImplementation(async () => {
    const err = new Error("Permission denied") as any;
    err.code = 403;
    throw err;
  });
  await expect(getVM("valheim-server")).rejects.toThrow("Permission denied");
});

test("createVM calls insert with correct name, metadata startup-script and bucket-name", async () => {
  mockInsert.mockImplementation(async () => [{ name: "op-123" }]);
  await createVM("valheim-server");
  expect(mockInsert).toHaveBeenCalledTimes(1);
  const [req] = mockInsert.mock.calls[0] as any[];
  expect(req.instanceResource.name).toBe("valheim-server");
  const items: Array<{ key: string; value: string }> =
    req.instanceResource.metadata.items;
  expect(items.some((i) => i.key === "startup-script")).toBe(true);
  expect(items.some((i) => i.key === "bucket-name" && i.value === "test-bucket")).toBe(true);
});

test("deleteVM calls delete with correct instance name", async () => {
  mockInstanceDelete.mockImplementation(async () => [{ name: "op-456" }]);
  await deleteVM("valheim-server");
  expect(mockInstanceDelete).toHaveBeenCalledTimes(1);
  const [req] = mockInstanceDelete.mock.calls[0] as any[];
  expect(req.instance).toBe("valheim-server");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/gcp/vm.test.ts
```

Expected: 6 failures — module not found.

- [ ] **Step 3: Implement `src/gcp/vm.ts`**

```typescript
import { InstancesClient, ZoneOperationsClient } from "@google-cloud/compute";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const client = new InstancesClient();
const zoneOps = new ZoneOperationsClient();

export interface VMInfo {
  status: string;
  ip: string;
}

export async function getVM(name: string): Promise<VMInfo | null> {
  try {
    const [instance] = await client.get({
      project: process.env.PROJECT_ID!,
      zone: process.env.ZONE!,
      instance: name,
    });
    const ip =
      instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? "";
    return { status: instance.status ?? "UNKNOWN", ip };
  } catch (e: any) {
    // gRPC NOT_FOUND = 5, HTTP NOT_FOUND = 404
    if (e.code === 5 || e.code === 404) return null;
    throw e;
  }
}

async function waitForOperation(operationName: string): Promise<void> {
  while (true) {
    const [op] = await zoneOps.get({
      project: process.env.PROJECT_ID!,
      zone: process.env.ZONE!,
      operation: operationName,
    });
    if (op.status === "DONE") {
      if (op.error?.errors?.length) {
        throw new Error(op.error.errors[0]?.message ?? "GCP operation failed");
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

export async function createVM(name: string): Promise<void> {
  const startupScript = readFileSync(
    join(import.meta.dir, "../../scripts/startup.sh"),
    "utf-8"
  );

  const [operation] = await client.insert({
    project: process.env.PROJECT_ID!,
    zone: process.env.ZONE!,
    instanceResource: {
      name,
      machineType: `zones/${process.env.ZONE}/machineTypes/${process.env.MACHINE_TYPE}`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: `projects/${process.env.PROJECT_ID}/global/images/${process.env.IMAGE_NAME}`,
          },
        },
      ],
      networkInterfaces: [
        {
          accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
        },
      ],
      metadata: {
        items: [
          { key: "startup-script", value: startupScript },
          { key: "bucket-name", value: process.env.BUCKET_NAME! },
        ],
      },
    },
  });

  if (operation.name) await waitForOperation(operation.name);
}

export async function deleteVM(name: string): Promise<void> {
  const [operation] = await client.delete({
    project: process.env.PROJECT_ID!,
    zone: process.env.ZONE!,
    instance: name,
  });

  if (operation.name) await waitForOperation(operation.name);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/gcp/vm.test.ts
```

Expected: `6 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/gcp/vm.ts src/gcp/vm.test.ts
git commit -m "feat: add GCP VM helpers (getVM, createVM, deleteVM)"
```

---

## Task 4: `/valheim start` Command (`src/commands/start.ts`)

**Files:**
- Create: `src/commands/start.ts`
- Create: `src/commands/start.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/commands/start.test.ts`:

```typescript
import { mock, expect, test, beforeEach } from "bun:test";

process.env.VM_NAME = "valheim-server";

const mockGetVM = mock(async (_name: string) => null as import("../gcp/vm").VMInfo | null);
const mockCreateVM = mock(async (_name: string) => {});
const mockWaitForFlag = mock(async (_path: string, _timeout: number) => {});
const mockDeleteFlag = mock(async (_path: string) => {});

mock.module("../gcp/vm.ts", () => ({
  getVM: mockGetVM,
  createVM: mockCreateVM,
  deleteVM: mock(async () => {}),
}));

mock.module("../gcp/storage.ts", () => ({
  waitForFlag: mockWaitForFlag,
  deleteFlag: mockDeleteFlag,
}));

const { handleStart } = await import("./start.ts");

function makeMockInteraction() {
  return {
    deferReply: mock(async () => {}),
    editReply: mock(async (_msg: string) => {}),
  };
}

beforeEach(() => {
  mockGetVM.mockReset();
  mockCreateVM.mockReset();
  mockWaitForFlag.mockReset();
  mockDeleteFlag.mockReset();
  mockGetVM.mockImplementation(async () => null);
  mockCreateVM.mockImplementation(async () => {});
  mockWaitForFlag.mockImplementation(async () => {});
  mockDeleteFlag.mockImplementation(async () => {});
});

test("handleStart: defers reply immediately", async () => {
  mockGetVM.mockImplementation(async () => ({ status: "RUNNING", ip: "1.2.3.4" }));
  const interaction = makeMockInteraction();
  await handleStart(interaction as any);
  expect(interaction.deferReply).toHaveBeenCalledTimes(1);
});

test("handleStart: reports existing server if VM already running", async () => {
  mockGetVM.mockImplementation(async () => ({ status: "RUNNING", ip: "1.2.3.4" }));
  const interaction = makeMockInteraction();
  await handleStart(interaction as any);
  expect(interaction.editReply).toHaveBeenCalledWith(
    expect.stringContaining("already running")
  );
  expect(mockCreateVM).not.toHaveBeenCalled();
});

test("handleStart: creates VM and reports IP on success", async () => {
  mockGetVM
    .mockImplementationOnce(async () => null)
    .mockImplementationOnce(async () => ({ status: "RUNNING", ip: "5.6.7.8" }));
  const interaction = makeMockInteraction();
  await handleStart(interaction as any);
  expect(mockCreateVM).toHaveBeenCalledTimes(1);
  const lastCall = (interaction.editReply.mock.calls.at(-1) as [string])[0];
  expect(lastCall).toContain("5.6.7.8:2456");
});

test("handleStart: reports timeout if ready flag never appears", async () => {
  mockGetVM.mockImplementation(async () => null);
  mockWaitForFlag.mockImplementation(async () => {
    throw new Error("Timeout waiting for flag: status/ready.flag");
  });
  const interaction = makeMockInteraction();
  await handleStart(interaction as any);
  const lastCall = (interaction.editReply.mock.calls.at(-1) as [string])[0];
  expect(lastCall).toContain("Timed out");
  expect(mockCreateVM).toHaveBeenCalledTimes(1);
});

test("handleStart: reports unexpected GCP error", async () => {
  mockGetVM.mockImplementation(async () => null);
  mockCreateVM.mockImplementation(async () => {
    throw new Error("Quota exceeded");
  });
  const interaction = makeMockInteraction();
  await handleStart(interaction as any);
  const lastCall = (interaction.editReply.mock.calls.at(-1) as [string])[0];
  expect(lastCall).toContain("Unexpected error");
  expect(lastCall).toContain("Quota exceeded");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/commands/start.test.ts
```

Expected: 5 failures — module not found.

- [ ] **Step 3: Implement `src/commands/start.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/commands/start.test.ts
```

Expected: `5 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/start.ts src/commands/start.test.ts
git commit -m "feat: implement /valheim start command"
```

---

## Task 5: `/valheim stop` Command (`src/commands/stop.ts`)

**Files:**
- Create: `src/commands/stop.ts`
- Create: `src/commands/stop.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/commands/stop.test.ts`:

```typescript
import { mock, expect, test, beforeEach } from "bun:test";

process.env.VM_NAME = "valheim-server";
process.env.SHUTDOWN_PORT = "8080";

const mockGetVM = mock(async (_name: string) => ({
  status: "RUNNING",
  ip: "1.2.3.4",
}) as import("../gcp/vm").VMInfo | null);
const mockDeleteVM = mock(async (_name: string) => {});
const mockWaitForFlag = mock(async (_path: string, _timeout: number) => {});
const mockDeleteFlag = mock(async (_path: string) => {});
const mockFetch = mock(async (_url: string, _opts?: RequestInit): Promise<Response> =>
  ({ ok: true, status: 202 }) as Response
);

mock.module("../gcp/vm.ts", () => ({
  getVM: mockGetVM,
  createVM: mock(async () => {}),
  deleteVM: mockDeleteVM,
}));

mock.module("../gcp/storage.ts", () => ({
  waitForFlag: mockWaitForFlag,
  deleteFlag: mockDeleteFlag,
}));

global.fetch = mockFetch as unknown as typeof fetch;

const { handleStop } = await import("./stop.ts");

function makeMockInteraction() {
  return {
    deferReply: mock(async () => {}),
    editReply: mock(async (_msg: string) => {}),
  };
}

beforeEach(() => {
  mockGetVM.mockReset();
  mockDeleteVM.mockReset();
  mockWaitForFlag.mockReset();
  mockDeleteFlag.mockReset();
  mockFetch.mockReset();
  mockGetVM.mockImplementation(async () => ({ status: "RUNNING", ip: "1.2.3.4" }));
  mockDeleteVM.mockImplementation(async () => {});
  mockWaitForFlag.mockImplementation(async () => {});
  mockDeleteFlag.mockImplementation(async () => {});
  mockFetch.mockImplementation(async () => ({ ok: true, status: 202 }) as Response);
});

test("handleStop: defers reply immediately", async () => {
  const interaction = makeMockInteraction();
  await handleStop(interaction as any);
  expect(interaction.deferReply).toHaveBeenCalledTimes(1);
});

test("handleStop: reports no server running if VM not found", async () => {
  mockGetVM.mockImplementation(async () => null);
  const interaction = makeMockInteraction();
  await handleStop(interaction as any);
  const lastCall = (interaction.editReply.mock.calls.at(-1) as [string])[0];
  expect(lastCall).toContain("No server");
  expect(mockDeleteVM).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

test("handleStop: calls shutdown endpoint with correct URL", async () => {
  const interaction = makeMockInteraction();
  await handleStop(interaction as any);
  const url = (mockFetch.mock.calls[0] as [string])[0];
  expect(url).toBe("http://1.2.3.4:8080/shutdown");
});

test("handleStop: full success flow deletes VM and reports done", async () => {
  const interaction = makeMockInteraction();
  await handleStop(interaction as any);
  expect(mockDeleteVM).toHaveBeenCalledTimes(1);
  const lastCall = (interaction.editReply.mock.calls.at(-1) as [string])[0];
  expect(lastCall).toContain("Server stopped");
});

test("handleStop: reports error and does not delete VM if shutdown endpoint unreachable", async () => {
  mockFetch.mockImplementation(async () => {
    throw new Error("connection refused");
  });
  const interaction = makeMockInteraction();
  await handleStop(interaction as any);
  const lastCall = (interaction.editReply.mock.calls.at(-1) as [string])[0];
  expect(lastCall).toContain("Could not reach VM");
  expect(mockDeleteVM).not.toHaveBeenCalled();
});

test("handleStop: reports timeout and does not delete VM if done flag never appears", async () => {
  mockWaitForFlag.mockImplementation(async () => {
    throw new Error("Timeout waiting for flag: status/done.flag");
  });
  const interaction = makeMockInteraction();
  await handleStop(interaction as any);
  const lastCall = (interaction.editReply.mock.calls.at(-1) as [string])[0];
  expect(lastCall).toContain("Timed out");
  expect(mockDeleteVM).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/commands/stop.test.ts
```

Expected: 6 failures — module not found.

- [ ] **Step 3: Implement `src/commands/stop.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/commands/stop.test.ts
```

Expected: `6 pass, 0 fail`.

- [ ] **Step 5: Run the full test suite**

```bash
bun test
```

Expected: all tests across all files pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/stop.ts src/commands/stop.test.ts
git commit -m "feat: implement /valheim stop command"
```

---

## Task 6: Bot Entry Point (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Implement `src/index.ts`**

Replace the stub with:

```typescript
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
```

- [ ] **Step 2: Verify TypeScript compiles without errors**

```bash
bun tsc --noEmit
```

Expected: no output (zero errors).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: implement bot entry point with gateway and command registration"
```

---

## Task 7: VM Scripts

**Files:**
- Create: `scripts/startup.sh`
- Create: `scripts/stop.sh`
- Create: `scripts/shutdown-server.py`

- [ ] **Step 1: Create `scripts/startup.sh`**

```bash
#!/bin/bash
set -euo pipefail

# Read bucket name injected as VM metadata by the Discord bot
BUCKET=$(curl -sf -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/bucket-name")
export BUCKET

echo "[startup] Bucket: $BUCKET"

# Clean any stale flags from a previous crashed run
gsutil -q rm "gs://$BUCKET/status/ready.flag" 2>/dev/null || true
gsutil -q rm "gs://$BUCKET/status/done.flag" 2>/dev/null || true

# Download world save
echo "[startup] Syncing world save from GCS..."
gsutil -m rsync "gs://$BUCKET/saves/" /opt/valheim/worlds/ 2>/dev/null || true

# Start the shutdown HTTP server (receives POST /shutdown from the Discord bot)
nohup python3 /opt/valheim/shutdown-server.py \
  > /var/log/shutdown-server.log 2>&1 &

# Start Valheim headless server as the valheim system user
echo "[startup] Starting Valheim headless server..."
sudo -u valheim nohup /opt/valheim/valheim_server.x86_64 \
  -name "Valheim Server" \
  -world "Dedicated" \
  -password "changeme" \
  -savedir /opt/valheim/worlds \
  -port 2456 \
  -nographics \
  -batchmode \
  > /var/log/valheim.log 2>&1 &
VALHEIM_PID=$!

echo "[startup] Valheim PID: $VALHEIM_PID"

# Poll for up to 3 minutes until the Valheim process is confirmed alive
for i in $(seq 1 18); do
  if [ -f "/proc/$VALHEIM_PID/status" ]; then
    echo "[startup] Valheim process alive (attempt $i)"
    break
  fi
  if [ "$i" -eq 18 ]; then
    echo "[startup] ERROR: Valheim failed to start after 3 minutes"
    exit 1
  fi
  echo "[startup] Waiting for Valheim to start (attempt $i/18)..."
  sleep 10
done

# Write ready flag — Discord bot is polling for this
echo "ready" | gsutil cp - "gs://$BUCKET/status/ready.flag"
echo "[startup] Ready flag written. Server is up."
```

- [ ] **Step 2: Create `scripts/stop.sh`**

```bash
#!/bin/bash
set -euo pipefail

# BUCKET must be set in the environment before calling this script
: "${BUCKET:?BUCKET env var is required}"

echo "[stop] Stopping Valheim..."

VALHEIM_PID=$(pgrep -f "valheim_server.x86_64" || true)

if [ -n "$VALHEIM_PID" ]; then
  echo "[stop] Sending SIGTERM to PID $VALHEIM_PID..."
  kill -TERM "$VALHEIM_PID"

  # Wait up to 60 seconds for graceful exit
  for i in $(seq 1 12); do
    if ! kill -0 "$VALHEIM_PID" 2>/dev/null; then
      echo "[stop] Valheim exited cleanly"
      break
    fi
    echo "[stop] Waiting for Valheim to exit (attempt $i/12)..."
    sleep 5
  done

  # Force kill if still running after 60 seconds
  if kill -0 "$VALHEIM_PID" 2>/dev/null; then
    echo "[stop] Force killing Valheim..."
    kill -9 "$VALHEIM_PID" || true
    sleep 2
  fi
else
  echo "[stop] No Valheim process found, continuing with save upload..."
fi

# Upload world save to GCS
echo "[stop] Uploading world save to GCS..."
gsutil -m rsync /opt/valheim/worlds/ "gs://$BUCKET/saves/"

# Write done flag — Discord bot is polling for this
echo "done" | gsutil cp - "gs://$BUCKET/status/done.flag"
echo "[stop] Done flag written. Shutdown complete."
```

- [ ] **Step 3: Create `scripts/shutdown-server.py`**

```python
#!/usr/bin/env python3
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

BUCKET = os.environ.get("BUCKET", "")
PORT = 8080


def run_stop() -> None:
    env = os.environ.copy()
    env["BUCKET"] = BUCKET
    subprocess.run(["/opt/valheim/stop.sh"], env=env, check=False)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path == "/shutdown":
            self.send_response(202)
            self.end_headers()
            threading.Thread(target=run_stop, daemon=True).start()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"[shutdown-server] {format % args}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[shutdown-server] Listening on :{PORT}")
    server.serve_forever()
```

- [ ] **Step 4: Make shell scripts executable**

```bash
chmod +x scripts/startup.sh scripts/stop.sh
```

- [ ] **Step 5: Commit**

```bash
git add scripts/startup.sh scripts/stop.sh scripts/shutdown-server.py
git commit -m "feat: add VM-side startup, stop, and shutdown server scripts"
```

---

## Task 8: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README.md with complete setup guide**

```markdown
# gserver — Valheim Discord Bot

Discord bot that manages an on-demand Valheim dedicated server on GCP.
`/valheim start` — spins up a VM, downloads the world save, starts Valheim.
`/valheim stop` — saves the world to GCS, shuts down Valheim, deletes the VM.

## Prerequisites

- GCP project with billing enabled
- `gcloud` CLI authenticated (`gcloud auth login`)
- Application Default Credentials configured (`gcloud auth application-default login`)
- A Discord application with a bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- Bun installed ([bun.sh](https://bun.sh))

---

## 1. Create the GCS Bucket

```bash
gsutil mb -l southamerica-east1 gs://YOUR_BUCKET_NAME
gsutil mb gs://YOUR_BUCKET_NAME/saves/
gsutil mb gs://YOUR_BUCKET_NAME/status/
```

Grant the VM's service account access:

```bash
gsutil iam ch serviceAccount:YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com:roles/storage.objectAdmin gs://YOUR_BUCKET_NAME
```

---

## 2. Build the Custom GCP Image

The custom image has Steam, SteamCMD, and Valheim pre-installed so VM boot time is fast.

**2a. Create a base VM:**

```bash
gcloud compute instances create valheim-image-builder \
  --zone=southamerica-east1-b \
  --machine-type=e2-standard-2 \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=50GB
```

**2b. SSH in and set up Valheim:**

```bash
gcloud compute ssh valheim-image-builder --zone=southamerica-east1-b
```

Inside the VM:

```bash
# Install dependencies
sudo apt-get update && sudo apt-get install -y lib32gcc-s1 python3 curl

# Install Google Cloud SDK (for gsutil)
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
  | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg \
  | sudo apt-key --keyring /usr/share/keyrings/cloud.google.gpg add -
sudo apt-get update && sudo apt-get install -y google-cloud-cli

# Create valheim user and directories
sudo useradd -r -s /bin/bash -d /opt/valheim valheim
sudo mkdir -p /opt/valheim/worlds
sudo chown -R valheim:valheim /opt/valheim

# Install SteamCMD
cd /tmp
curl -sqL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar xvz
sudo mv steamcmd.sh /usr/local/bin/steamcmd

# Download Valheim dedicated server (AppID 896660)
sudo -u valheim /usr/local/bin/steamcmd \
  +@sSteamCmdForcePlatformType linux \
  +force_install_dir /opt/valheim \
  +login anonymous \
  +app_update 896660 validate \
  +quit
```

**2c. Copy scripts to the VM:**

```bash
# From your local machine:
gcloud compute scp scripts/stop.sh valheim-image-builder:/tmp/ --zone=southamerica-east1-b
gcloud compute scp scripts/shutdown-server.py valheim-image-builder:/tmp/ --zone=southamerica-east1-b

# Back in the VM SSH session:
sudo mv /tmp/stop.sh /opt/valheim/stop.sh
sudo mv /tmp/shutdown-server.py /opt/valheim/shutdown-server.py
sudo chmod +x /opt/valheim/stop.sh
sudo chown valheim:valheim /opt/valheim/stop.sh /opt/valheim/shutdown-server.py
```

**2d. Create the image:**

```bash
# Stop the VM first
gcloud compute instances stop valheim-image-builder --zone=southamerica-east1-b

# Create image from disk
gcloud compute images create valheim-base-v1 \
  --source-disk=valheim-image-builder \
  --source-disk-zone=southamerica-east1-b \
  --description="Valheim dedicated server base image"

# Clean up the builder VM
gcloud compute instances delete valheim-image-builder --zone=southamerica-east1-b
```

---

## 3. Set Up Firewall Rules

```bash
# Valheim game ports (UDP) — open to all players
gcloud compute firewall-rules create valheim-game \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=udp:2456-2458 \
  --target-tags=valheim-server

# Shutdown endpoint (TCP 8080) — restrict to your bot host's IP
gcloud compute firewall-rules create valheim-shutdown \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:8080 \
  --source-ranges=YOUR_BOT_HOST_IP/32 \
  --target-tags=valheim-server
```

> To apply these tags to VMs created by the bot, add `tags: { items: ["valheim-server"] }` to the `instanceResource` in `src/gcp/vm.ts`.

---

## 4. Configure the Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → add a bot
3. Copy the **Bot Token** and **Application ID**
4. Invite the bot to your server with `applications.commands` scope

---

## 5. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values
```

---

## 6. Run the Bot

```bash
bun install
bun run src/index.ts
```

The bot registers slash commands on startup and then listens for interactions. Use `/valheim start` and `/valheim stop` in your Discord server.

---

## Updating `startup.sh` Without Rebuilding the Image

`startup.sh` is injected as VM metadata on each `/valheim start` — edit `scripts/startup.sh` and restart the bot. No image rebuild needed.

To update `stop.sh` or `shutdown-server.py`, rebuild the image (step 2).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add setup guide and custom image instructions"
```

---

## Final Verification

- [ ] **Run full test suite one last time**

```bash
bun test
```

Expected: all tests pass across `storage.test.ts`, `vm.test.ts`, `start.test.ts`, `stop.test.ts`.

- [ ] **TypeScript type check**

```bash
bun tsc --noEmit
```

Expected: zero errors.
