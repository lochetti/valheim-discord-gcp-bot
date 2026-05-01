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
  expect(mockDeleteFlag).toHaveBeenCalledWith("status/ready.flag");
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
