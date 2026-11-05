import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import {
  InventoryFileStore,
  InventoryStoreError,
} from "../agent/prediction_inventory_store.js";
import {
  PredictionInventoryReader,
  inventoryHttpRpc,
  InventoryProofError,
  type InventoryCheckpoint,
} from "../agent/prediction_inventory.js";

// Deliberately separate from trading/Agent startup. No automatic backfill or
// network work is enabled by a deployment or by the normal account read path.
export async function predictionInventoryCommand(
  command: string,
  env = process.env,
) {
  if (env.RIDE_PREDICTION_INVENTORY_PROOF_ENABLED !== "true")
    throw new InventoryProofError("INVENTORY_PROOF_DISABLED");
  const path = env.RIDE_PREDICTION_INVENTORY_CHECKPOINT,
    owner = env.RIDE_PREDICTION_INVENTORY_OWNER;
  if (
    !path ||
    !isAbsolute(path) ||
    !owner ||
    !env.RIDE_PREDICTION_INVENTORY_RPC_URL ||
    !env.RIDE_PREDICTION_INVENTORY_PROVIDER_POLICY
  )
    throw new InventoryProofError("INVENTORY_CONFIG_REQUIRED");
  if (command !== "advance" && command !== "read" && command !== "narrow")
    throw new InventoryProofError("INVENTORY_COMMAND_INVALID");
  let policy;
  try {
    policy = JSON.parse(
      await readFile(env.RIDE_PREDICTION_INVENTORY_PROVIDER_POLICY, "utf8"),
    );
  } catch {
    throw new InventoryProofError("PROVIDER_CONTRACT_REQUIRED");
  }
  const reader = new PredictionInventoryReader(
    new InventoryFileStore<InventoryCheckpoint>(path),
    inventoryHttpRpc(env.RIDE_PREDICTION_INVENTORY_RPC_URL),
    policy,
  );
  if (command === "read") {
    const proof = await reader.read(owner);
    return {
      inventory_complete: proof.inventory_complete,
      valuation_complete: false,
      prediction_execution_ready: false,
      block_number: proof.block.number,
      scope: proof.scope.version,
      held_token_count: proof.holdings.length,
    };
  }
  const state =
    command === "narrow"
      ? await reader.narrowWindow(owner)
      : await reader.advance(owner);
  const complete = state.ledgers.every(
    (l) =>
      l.next_block === state.target.number + 1 &&
      l.balances.length === l.token_ids.length,
  );
  return {
    revision: state.revision,
    target_block: state.target.number,
    inventory_scan_complete: complete,
    proof_read_required: true,
    valuation_complete: false,
    prediction_execution_ready: false,
    progress: state.ledgers.map((l) => ({
      through_block: l.next_block - 1,
      enumerated_tokens: l.token_ids.length,
      verified_balances: l.balances.length,
      window_span: l.window_span,
    })),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  predictionInventoryCommand(process.argv[2])
    .then((value) => process.stdout.write(JSON.stringify(value) + "\n"))
    .catch((error) => {
      // No raw Error, RPC endpoint, wallet, policy file, key or envelope in output.
      process.stderr.write(
        JSON.stringify({
          error:
            error instanceof InventoryProofError ||
            error instanceof InventoryStoreError
              ? error.code
              : "INVENTORY_PROOF_FAILED",
        }) + "\n",
      );
      process.exitCode = 1;
    });
}
