# Starknet Stork CLI

Deployment and administration for the Stork Cairo contract, built on
[starknet.js](https://github.com/starknet-io/starknet.js).

## Setup

```bash
npm install
```

Configuration is by environment variable, matching the other chains' CLIs:

| Variable | Purpose |
| --- | --- |
| `STARKNET_RPC_URL` | Node endpoint. Defaults to `https://api.cartridge.gg/x/starknet/sepolia`. |
| `STARKNET_ACCOUNT_ADDRESS` | Deployed account contract to send from. |
| `STARKNET_PRIVATE_KEY` | Stark private key controlling that account. |
| `STORK_CONTRACT_ADDRESS` | The deployed Stork contract, for every command except `deploy`. |
| `STORK_EVM_PUBLIC_KEY` | Overrides the default Stork signing key used by `deploy`. |

## Deploying to Sepolia

Build the contract first — the CLI reads the artifacts from `../contracts/target/dev`:

```bash
cd ../contracts && scarb build && cd -
```

Then declare and deploy. You need a funded, already-deployed Sepolia account; fund one from the
[Starknet faucet](https://starknet-faucet.vercel.app/).

```bash
export STARKNET_RPC_URL=https://api.cartridge.gg/x/starknet/sepolia
export STARKNET_ACCOUNT_ADDRESS=0x...
export STARKNET_PRIVATE_KEY=0x...

npx tsx admin.ts deploy --stork-public-key 0x<stork-signing-key>
```

`deploy` prints the class hash, the contract address, and the `export STORK_CONTRACT_ADDRESS=...`
line to feed the remaining commands. Options:

| Option | Default |
| --- | --- |
| `--stork-public-key` | `0x0a803F9b1CCe32e2773e0d2e98b37E0775cA5d44` |
| `--valid-time-period <seconds>` | `3600` |
| `--single-update-fee <amount>` | `0` |
| `--fee-token <address>` | `0x0`, required when the fee is non-zero |
| `--owner <address>` | the deploying account |

Confirm the result, then point the pusher at it:

```bash
npx tsx admin.ts info

go run ./main.go starknet \
    -w wss://api.jp.stork-oracle.network -a <stork-api-key> \
    -r $STARKNET_RPC_URL \
    -x $STORK_CONTRACT_ADDRESS \
    -n $STARKNET_ACCOUNT_ADDRESS \
    -f asset-config.yaml -k private-key.secret
```

## Commands

| Command | Purpose |
| --- | --- |
| `deploy` | Declare and deploy the contract. |
| `info` | Print the deployed contract's configuration. |
| `read <encodedAssetId> [--checked]` | Read a feed's latest value. |
| `set-fee <amount>` / `set-fee-token <address>` | Fee configuration. |
| `set-valid-time-period <seconds>` | Staleness window. |
| `rotate-stork-key <ethAddress>` | Rotate the canonical signing key. |
| `add-signing-address` / `remove-signing-address` | Manage the accepted signer set. |
| `transfer-ownership` / `accept-ownership` | Two-step ownership handover. |
| `upgrade <classHash>` | Replace the contract class. |

## Version notes

`starknet` is pinned to an exact version rather than a caret range: this tooling signs
transactions against real funds, and the 10.x line publishes frequently, with some releases
carrying the `next` dist-tag rather than `latest`.

The pinned release supports JSON-RPC specs 0.9.0, 0.10.0 and 0.10.2, so it works against providers
on either side of the current migration. The Go pusher's client is stricter — see
[the pusher README](../../../apps/chain_pusher/pkg/starknet/README.md) for how to match them up.
