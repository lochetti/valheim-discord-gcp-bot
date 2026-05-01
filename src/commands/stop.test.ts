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
