import { readFileSync } from "fs";
import { join } from "path";
import { Command } from "commander";
import {
  Account,
  CallData,
  compareVersions,
  Contract,
  RpcProvider,
  cairo,
  json,
  num,
  shortString,
  uint256,
  type Abi,
  type BigNumberish,
  type CompiledSierra,
  type CompiledSierraCasm,
} from "starknet";

// Public Starknet Sepolia endpoint. Providers serve different JSON-RPC spec versions on the same
// network, and the pusher's Go client needs 0.10.2 or newer, so the default is one that serves it.
// `preflight` checks whichever endpoint you actually point at.
const DEFAULT_RPC_URL =
  process.env.STARKNET_RPC_URL ?? "https://starknet-sepolia-rpc.publicnode.com";

// The JSON-RPC spec version the Go pusher's pinned client requires for transaction submission.
const MIN_RPC_SPEC = "0.10.2";

// Fee tokens, the same addresses on Sepolia and mainnet.
const STRK_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ETH_ADDRESS = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";

const CONTRACT_ADDRESS = process.env.STORK_CONTRACT_ADDRESS;
const ACCOUNT_ADDRESS = process.env.STARKNET_ACCOUNT_ADDRESS;
const PRIVATE_KEY = process.env.STARKNET_PRIVATE_KEY;

// Stork's public signing key. Override for a different environment.
const DEFAULT_STORK_EVM_PUBLIC_KEY =
  process.env.STORK_EVM_PUBLIC_KEY ?? "0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44";

// One hour, matching the EVM deployments' default staleness window.
const DEFAULT_VALID_TIME_PERIOD_SECONDS = 3600;

const ARTIFACT_DIR = join(__dirname, "..", "contracts", "target", "dev");
const SIERRA_ARTIFACT = "stork_Stork.contract_class.json";
const CASM_ARTIFACT = "stork_Stork.compiled_contract_class.json";

function getProvider(): RpcProvider {
  return new RpcProvider({ nodeUrl: DEFAULT_RPC_URL });
}

function getAccount(): Account {
  if (!ACCOUNT_ADDRESS) {
    throw new Error("STARKNET_ACCOUNT_ADDRESS is not set");
  }
  if (!PRIVATE_KEY) {
    throw new Error("STARKNET_PRIVATE_KEY is not set");
  }

  return new Account({
    provider: getProvider(),
    address: ACCOUNT_ADDRESS,
    signer: PRIVATE_KEY,
  });
}

function requireContractAddress(): string {
  if (!CONTRACT_ADDRESS) {
    throw new Error("STORK_CONTRACT_ADDRESS is not set");
  }

  return CONTRACT_ADDRESS;
}

function loadArtifacts(): { sierra: CompiledSierra; casm: CompiledSierraCasm } {
  try {
    return {
      sierra: json.parse(readFileSync(join(ARTIFACT_DIR, SIERRA_ARTIFACT)).toString("ascii")),
      casm: json.parse(readFileSync(join(ARTIFACT_DIR, CASM_ARTIFACT)).toString("ascii")),
    };
  } catch (error) {
    throw new Error(
      `failed to read contract artifacts from ${ARTIFACT_DIR}. ` +
        `Run 'scarb build' in chains/starknet/contracts first. Cause: ${error}`,
    );
  }
}

function getContract(): Contract {
  const { sierra } = loadArtifacts();

  return new Contract({
    abi: sierra.abi as Abi,
    address: requireContractAddress(),
    providerOrAccount: getAccount(),
  });
}

async function assertAccountIsUsable(account: Account): Promise<void> {
  // A missing or undeployed account produces an opaque failure deep inside fee estimation, so
  // surface it here instead.
  try {
    await account.getNonce();
  } catch (error) {
    throw new Error(
      `account ${account.address} is not usable on ${DEFAULT_RPC_URL}. ` +
        `Check that it is deployed and funded. Cause: ${error}`,
    );
  }
}

const cliProgram = new Command();
cliProgram
  .name("admin")
  .description("Starknet Stork admin client")
  .version("0.1.0");

cliProgram
  .command("deploy")
  .description("Declare and deploy the Stork contract")
  .option(
    "-k, --stork-public-key <key>",
    "Stork's EVM signing key",
    DEFAULT_STORK_EVM_PUBLIC_KEY,
  )
  .option(
    "-t, --valid-time-period <seconds>",
    "staleness window in seconds",
    String(DEFAULT_VALID_TIME_PERIOD_SECONDS),
  )
  .option("-f, --single-update-fee <amount>", "fee charged per applied update", "0")
  .option(
    "-o, --fee-token <address>",
    "ERC20 the fee is denominated in; required when the fee is non-zero",
    "0x0",
  )
  .option("--owner <address>", "initial owner, defaults to the deploying account")
  .action(async (options) => {
    const account = getAccount();
    await assertAccountIsUsable(account);

    const owner = options.owner ?? account.address;
    const fee = BigInt(options.singleUpdateFee);
    const feeToken = options.feeToken;

    // The contract rejects this combination, but failing here saves a reverted transaction.
    if (fee !== 0n && BigInt(feeToken) === 0n) {
      throw new Error("--fee-token is required when --single-update-fee is non-zero");
    }

    const { sierra, casm } = loadArtifacts();

    const constructorCalldata = new CallData(sierra.abi as Abi).compile("constructor", {
      initial_owner: owner,
      stork_public_key: options.storkPublicKey,
      valid_time_period_seconds: options.validTimePeriod,
      single_update_fee: cairo.uint256(fee),
      fee_token: feeToken,
    });

    console.log(`rpc:        ${DEFAULT_RPC_URL}`);
    console.log(`deployer:   ${account.address}`);
    console.log(`owner:      ${owner}`);
    console.log(`stork key:  ${options.storkPublicKey}`);
    console.log(`valid time: ${options.validTimePeriod}s`);
    console.log(`fee:        ${fee} (token ${feeToken})`);
    console.log("\ndeclaring and deploying, this can take a few minutes...");

    const response = await account.declareAndDeploy({
      contract: sierra,
      casm,
      constructorCalldata,
    });

    console.log("\ndeployed");
    console.log(`  class hash:       ${response.declare.class_hash}`);
    console.log(`  contract address: ${response.deploy.contract_address}`);
    console.log(`  declare tx:       ${response.declare.transaction_hash}`);
    console.log(`  deploy tx:        ${response.deploy.transaction_hash}`);
    console.log(`\nexport STORK_CONTRACT_ADDRESS=${response.deploy.contract_address}`);
  });

cliProgram
  .command("preflight")
  .description("Check the RPC, account and artifacts are usable before spending funds")
  .action(async () => {
    let failed = false;
    const ok = (msg: string) => console.log(`  \u001b[32mok\u001b[0m    ${msg}`);
    const warn = (msg: string) => console.log(`  \u001b[33mwarn\u001b[0m  ${msg}`);
    const bad = (msg: string) => {
      console.log(`  \u001b[31mfail\u001b[0m  ${msg}`);
      failed = true;
    };

    console.log(`rpc: ${DEFAULT_RPC_URL}\n`);

    const provider = getProvider();

    let spec = "";
    try {
      spec = await provider.getSpecVersion();
      if (compareVersions(spec, MIN_RPC_SPEC) < 0) {
        bad(
          `node serves JSON-RPC spec ${spec}, but the Go pusher needs ${MIN_RPC_SPEC}+ to submit ` +
            `transactions. Reads will work, pushes will not.`,
        );
      } else {
        ok(`JSON-RPC spec ${spec}`);
      }
    } catch (error) {
      bad(`cannot reach the node: ${error}`);
    }

    try {
      const chainId = await provider.getChainId();
      ok(`chain id ${shortString.decodeShortString(chainId)}`);
    } catch (error) {
      bad(`cannot read the chain id: ${error}`);
    }

    if (!ACCOUNT_ADDRESS || !PRIVATE_KEY) {
      bad("STARKNET_ACCOUNT_ADDRESS and STARKNET_PRIVATE_KEY must both be set");
    } else {
      try {
        const account = getAccount();
        const nonce = await account.getNonce();
        ok(`account ${account.address} is deployed (nonce ${nonce})`);

        for (const [name, address] of [
          ["STRK", STRK_ADDRESS],
          ["ETH", ETH_ADDRESS],
        ]) {
          try {
            const balance = await provider.callContract({
              contractAddress: address,
              entrypoint: "balanceOf",
              calldata: [account.address],
            });
            const amount = uint256.uint256ToBN({ low: balance[0], high: balance[1] });
            const whole = Number(amount) / 1e18;
            if (name === "STRK" && amount === 0n) {
              warn(`${name} balance is 0; v3 transactions are paid in STRK, fund it from a faucet`);
            } else {
              ok(`${name} balance ${whole}`);
            }
          } catch {
            warn(`could not read the ${name} balance`);
          }
        }
      } catch (error) {
        bad(
          `account is not usable. It must be deployed on chain, not just a keypair. Cause: ${error}`,
        );
      }
    }

    try {
      loadArtifacts();
      ok("contract artifacts are built");
    } catch {
      bad("contract artifacts missing, run 'scarb build' in ../contracts");
    }

    if (CONTRACT_ADDRESS) {
      try {
        const version = await getContract().call("version");
        ok(
          `Stork contract at ${CONTRACT_ADDRESS} responds, version ` +
            shortString.decodeShortString(num.toHex(version as BigNumberish)),
        );
      } catch (error) {
        bad(`STORK_CONTRACT_ADDRESS is set but unreachable: ${error}`);
      }
    } else {
      console.log("  ----  STORK_CONTRACT_ADDRESS not set, nothing deployed yet");
    }

    console.log(failed ? "\nnot ready" : "\nready");
    if (failed) {
      process.exit(1);
    }
  });

cliProgram
  .command("info")
  .description("Print the deployed contract's configuration")
  .action(async () => {
    const contract = getContract();

    const [version, storkKey, signers, fee, feeToken, validTime, owner, pendingOwner] =
      await Promise.all([
        contract.call("version"),
        contract.call("stork_public_key"),
        contract.call("signing_addresses"),
        contract.call("single_update_fee"),
        contract.call("fee_token"),
        contract.call("valid_time_period_seconds"),
        contract.call("owner"),
        contract.call("pending_owner"),
      ]);

    console.log(`address:          ${contract.address}`);
    console.log(`version:          ${shortString.decodeShortString(num.toHex(version as BigNumberish))}`);
    console.log(`stork public key: ${num.toHex(storkKey as BigNumberish)}`);
    console.log(
      `signing keys:     ${(signers as BigNumberish[]).map((s) => num.toHex(s)).join(", ")}`,
    );
    console.log(`single update fee:${" "}${fee}`);
    console.log(`fee token:        ${num.toHex(feeToken as BigNumberish)}`);
    console.log(`valid time:       ${validTime}s`);
    console.log(`owner:            ${num.toHex(owner as BigNumberish)}`);
    console.log(`pending owner:    ${num.toHex(pendingOwner as BigNumberish)}`);
  });

cliProgram
  .command("read")
  .description("Read the latest value for an encoded asset id")
  .argument("<encodedAssetId>", "32 byte encoded asset id")
  .option("--checked", "apply the staleness check", false)
  .action(async (encodedAssetId: string, options) => {
    const contract = getContract();
    const entrypoint = options.checked
      ? "get_temporal_numeric_value_v1"
      : "get_temporal_numeric_value_unsafe_v1";

    const value = (await contract.call(entrypoint, [cairo.uint256(encodedAssetId)])) as {
      timestamp_ns: bigint;
      quantized_value: bigint;
    };

    console.log(`timestamp_ns:    ${value.timestamp_ns}`);
    console.log(`quantized_value: ${value.quantized_value}`);
  });

cliProgram
  .command("set-fee")
  .description("Set the per-update fee. Set the fee token first if moving away from zero")
  .argument("<amount>")
  .action(async (amount: string) => {
    const contract = getContract();
    const tx = await contract.invoke("update_single_update_fee", [cairo.uint256(BigInt(amount))]);
    console.log(`tx: ${tx.transaction_hash}`);
  });

cliProgram
  .command("set-fee-token")
  .description("Set the ERC20 fees are collected in. Clear the fee before setting this to 0")
  .argument("<address>")
  .action(async (address: string) => {
    const contract = getContract();
    const tx = await contract.invoke("update_fee_token", [address]);
    console.log(`tx: ${tx.transaction_hash}`);
  });

cliProgram
  .command("set-valid-time-period")
  .description("Set the staleness window in seconds")
  .argument("<seconds>")
  .action(async (seconds: string) => {
    const contract = getContract();
    const tx = await contract.invoke("update_valid_time_period_seconds", [seconds]);
    console.log(`tx: ${tx.transaction_hash}`);
  });

cliProgram
  .command("rotate-stork-key")
  .description("Rotate the canonical Stork signing key; the previous key stays accepted")
  .argument("<ethAddress>")
  .action(async (ethAddress: string) => {
    const contract = getContract();
    const tx = await contract.invoke("update_stork_public_key", [ethAddress]);
    console.log(`tx: ${tx.transaction_hash}`);
  });

cliProgram
  .command("add-signing-address")
  .description("Add an accepted Stork signing key")
  .argument("<ethAddress>")
  .action(async (ethAddress: string) => {
    const contract = getContract();
    const tx = await contract.invoke("add_signing_address", [ethAddress]);
    console.log(`tx: ${tx.transaction_hash}`);
  });

cliProgram
  .command("remove-signing-address")
  .description("Remove an accepted Stork signing key")
  .argument("<ethAddress>")
  .action(async (ethAddress: string) => {
    const contract = getContract();
    const tx = await contract.invoke("remove_signing_address", [ethAddress]);
    console.log(`tx: ${tx.transaction_hash}`);
  });

cliProgram
  .command("transfer-ownership")
  .description("Start a two step ownership transfer")
  .argument("<address>")
  .action(async (address: string) => {
    const contract = getContract();
    const tx = await contract.invoke("transfer_ownership", [address]);
    console.log(`tx: ${tx.transaction_hash}`);
  });

cliProgram
  .command("accept-ownership")
  .description("Accept a pending ownership transfer")
  .action(async () => {
    const contract = getContract();
    const tx = await contract.invoke("accept_ownership", []);
    console.log(`tx: ${tx.transaction_hash}`);
  });

cliProgram
  .command("upgrade")
  .description("Replace the contract class")
  .argument("<classHash>")
  .action(async (classHash: string) => {
    const contract = getContract();
    const tx = await contract.invoke("upgrade", [classHash]);
    console.log(`tx: ${tx.transaction_hash}`);
  });

cliProgram.parseAsync(process.argv).catch((error) => {
  console.error(`\nerror: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
