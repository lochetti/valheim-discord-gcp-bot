import { mock, expect, test, beforeEach, afterAll } from "bun:test";

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

// Restore mocked intermediate modules to passthroughs that use the current (possibly
// mocked) leaf packages. This prevents mock.module contamination from leaking into
// subsequently-run test files (e.g. src/gcp/storage.test.ts, src/gcp/vm.test.ts).
// Bun 1.3.x shares a single module registry across all test files in one run;
// mock.restore() does not clear mock.module entries, so we must re-register manually.
afterAll(() => {
  mock.module("../gcp/storage.ts", () => ({
    waitForFlag: async (path: string, timeoutMs: number, intervalMs = 10_000): Promise<void> => {
      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({ projectId: process.env.PROJECT_ID });
      const bucket = storage.bucket(process.env.BUCKET_NAME!);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [exists] = await bucket.file(path).exists();
        if (exists) return;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw new Error(`Timeout waiting for flag: ${path}`);
    },
    deleteFlag: async (path: string): Promise<void> => {
      const { Storage } = await import("@google-cloud/storage");
      const storage = new Storage({ projectId: process.env.PROJECT_ID });
      await storage.bucket(process.env.BUCKET_NAME!).file(path).delete({ ignoreNotFound: true });
    },
  }));

  mock.module("../gcp/vm.ts", () => ({
    getVM: async (name: string) => {
      const { InstancesClient } = await import("@google-cloud/compute");
      try {
        const client = new InstancesClient();
        const [instance] = await client.get({
          project: process.env.PROJECT_ID!, zone: process.env.ZONE!, instance: name,
        });
        const ip = instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? "";
        return { status: instance.status ?? "UNKNOWN", ip };
      } catch (e: any) {
        if (e.code === 5 || e.code === 404) return null;
        throw e;
      }
    },
    createVM: async (name: string) => {
      const { InstancesClient, ZoneOperationsClient } = await import("@google-cloud/compute");
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const client = new InstancesClient();
      const zoneOps = new ZoneOperationsClient();
      const startupScript = readFileSync(join(import.meta.dir, "../../scripts/startup.sh"), "utf-8");
      const [op] = await client.insert({
        project: process.env.PROJECT_ID!, zone: process.env.ZONE!,
        instanceResource: {
          name,
          machineType: `zones/${process.env.ZONE}/machineTypes/${process.env.MACHINE_TYPE}`,
          disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: `projects/${process.env.PROJECT_ID}/global/images/${process.env.IMAGE_NAME}` } }],
          networkInterfaces: [{ accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }] }],
          metadata: { items: [{ key: "startup-script", value: startupScript }, { key: "bucket-name", value: process.env.BUCKET_NAME! }] },
        },
      });
      if (op.name) {
        const deadline = Date.now() + 15 * 60 * 1_000;
        while (Date.now() < deadline) {
          const [operation] = await zoneOps.get({ project: process.env.PROJECT_ID!, zone: process.env.ZONE!, operation: op.name });
          if (operation.status === "DONE") return;
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    },
    deleteVM: async (name: string) => {
      const { InstancesClient, ZoneOperationsClient } = await import("@google-cloud/compute");
      const client = new InstancesClient();
      const zoneOps = new ZoneOperationsClient();
      const [op] = await client.delete({ project: process.env.PROJECT_ID!, zone: process.env.ZONE!, instance: name });
      if (op.name) {
        const deadline = Date.now() + 15 * 60 * 1_000;
        while (Date.now() < deadline) {
          const [operation] = await zoneOps.get({ project: process.env.PROJECT_ID!, zone: process.env.ZONE!, operation: op.name });
          if (operation.status === "DONE") return;
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    },
  }));
});
