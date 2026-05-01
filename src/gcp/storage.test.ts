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
