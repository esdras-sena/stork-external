# Starknet Chain Pusher

The Starknet pusher, structured like every other chain in `apps/chain_pusher/pkg`: `push.go`
defines the cobra command, `interactor.go` implements `types.ContractInteractor`, and `bindings/`
talks to the contract.

The contract it pushes to lives in [`chains/starknet/contracts`](../../../../chains/starknet/contracts).

## Wallet setup

Starknet accounts are contracts, so the pusher needs two things rather than one:

* `--account-address` — the address of the deployed account contract.
* `--private-key-file` — a file containing the hex encoded Stark private key that controls it.

The account must already be deployed and funded.

## Running

```bash
go run ./main.go starknet --help
```

Basic usage:

```bash
go run ./main.go starknet \
    -w wss://api.jp.stork-oracle.network \
    -a <stork-api-key> \
    -r <chain-rpc-url> \
    -c <chain-ws-url> \
    -x <contract-address> \
    -n <account-address> \
    -f <asset-config-file> \
    -k <private-key-file>
```

`--chain-ws-url` is optional. When given, the pusher subscribes to the contract's `ValueUpdate`
events over `starknet_subscribeEvents` and tracks on-chain state without waiting for the poll
interval; without it, it falls back to polling only.

`--fee-token-address` is optional and only affects balance reporting.

## Fees

The contract charges `single_update_fee` per applied update, collected as an ERC20 `transfer_from`.
Deployments with a fee of 0 — the common case — need nothing extra. With a non-zero fee, the
pushing account must approve the Stork contract as a spender on the fee token, or updates will
revert.

## Bindings

There is no `abigen` equivalent for Starknet, so `bindings/` is written by hand and
[`bindings/serde.go`](bindings/serde.go) implements the Cairo calldata layout directly. The two
encodings that matter:

* `u256` is two field elements, low limb first.
* `i128` is a single field element, negative values embedded as `P - |v|`. Note that
  `utils.BigIntToFelt` builds a felt from `big.Int.Bytes()` and therefore drops the sign, so
  negative values must be reduced before conversion.

`serde_test.go` pins both, along with the entry point and event selectors.

## RPC spec versions

Starknet is mid-migration between JSON-RPC 0.9 and 0.10, and **providers differ**: at the time of
writing `api.cartridge.gg` serves 0.9.0 on Sepolia while `starknet-sepolia.drpc.org` serves 0.10.2.
The Go client implements one spec version and warns rather than fails when the node reports
another, but transaction submission can still break across a mismatch.

| | Implements | Notes |
| --- | --- | --- |
| `starknet.go v0.17.1` | 0.9.0 | Cannot submit transactions to a 0.10 node. |
| `starknet.go v0.18.0-beta.2` | 0.10.0 | Pinned here. Verified submitting against a 0.10.2 node. |

If updates fail during transaction submission, suspect a client/node spec mismatch first and
switch endpoints or move the pin. Two error strings that mean exactly that:
`the transaction's resources don't cover validation or the minimal transaction fee`, and
`unknown field 'proof_facts'` (a field the newer client emits that older nodes reject).

`--tip` sets an explicit transaction tip in FRI and skips the node's tip estimation. Leave it unset
to let the node estimate, which is the default; set it when a node does not serve estimation, or to
bid for faster inclusion on a busy network.

## Dependency status

`github.com/NethermindEth/starknet.go` carries a notice on its README:

> This repository is no longer under maintenance and will be archived soon.

It works, and the push path is verified against a node serving RPC 0.10.2, but it should not stay
the long-term basis for this package. No successor is named, and no fork has been pushed since the
notice went up. The realistic options are to vendor it, or to replace it with a minimal client
covering the five RPC methods and the V3 transaction signing this package actually uses.

This is separate from `github.com/NethermindEth/juno`, which is actively developed and was already
a dependency of this repo.

## Testing

Unit tests:

```bash
go test ./apps/chain_pusher/pkg/starknet/...
```

Integration tests push the signed fixtures from `internal/testutil/testdata` through a real
deployed contract and read them back. Deployment is the CLI's job, so deploy first and pass the
address in:

```bash
# a devnet serving RPC 0.10.2, matching the pinned client
starknet-devnet --seed 42

cd chains/starknet/contracts && scarb build && cd ../cli && npm install
STARKNET_RPC_URL=http://127.0.0.1:5050 \
STARKNET_ACCOUNT_ADDRESS=0x34ba56f92265f0868c57d3fe72ecab144fc96f97954bbbc4252cef8e8a979ba \
STARKNET_PRIVATE_KEY=0xb137668388dbe9acdfa3bc734cc2c469 \
  npx tsx admin.ts deploy --stork-public-key 0xC4A02e7D370402F4afC36032076B05e74FF81786

STORK_CONTRACT_ADDRESS=<printed address> \
  go test -tags integration ./apps/chain_pusher/pkg/starknet/...
```

The tests walk the fixtures forward until a batch is fresh, so they can be run repeatedly against
the same contract.
