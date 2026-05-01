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
