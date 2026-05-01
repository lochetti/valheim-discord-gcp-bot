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
