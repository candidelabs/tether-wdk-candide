# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This repository contains TypeScript example scripts showing how to build wallets using **WDK (Tether Wallet Development Kit)** together with **abstractionkit** (Candide). Each example is a self-contained script in its own folder under the project root.

## Key Dependencies

- `@tetherto/wdk-wallet-evm-erc-4337` — WDK: manages Safe smart accounts from BIP-39 seed phrases via ERC-4337. This is an **ESM-only** package.
- `abstractionkit` — Candide's SDK for Safe account utilities and the `SocialRecoveryModule` (guardian management). Ships CommonJS.
- `dotenv` — environment variable loading.

## Build & Run

```bash
npm install
npm run build               # compile all TypeScript to dist/
npx tsc --noEmit            # type-check without emitting
node dist/<example>/index.js   # run a compiled example
```

Examples can also be run directly via tsx (no compile step):

```bash
# UserOp submission examples
npm run send-userop-sponsored       # sponsored gas via policy
npm run send-userop-erc20           # gas paid in USDT (ERC-20)

# Personal guardian path
npm run add-personal-guardian                # 01 — set up guardians
npm run recovery-flow-personal-guardian  # 02 — run recovery flow
npm run cancel-recovery-personal    # 03 — cancel a recovery

# Email/SMS path
npm run enable-email-sms-recovery   # 01 — set up Candide guardian
npm run recovery-flow-email-sms          # 02 — run recovery flow
npm run cancel-recovery-email-sms   # 03 — cancel a recovery

# Shared (work with either recovery path)
npm run setup-alerts                # subscribe to recovery event notifications
npm run cancel-recovery             # cancel a pending recovery
```

## Project Structure

```
send-userop/
  01-sponsored-gas/   # UserOp with sponsored gas (isSponsored: true + policy ID)
  02-erc20-gas/       # UserOp with ERC-20 gas payment (USDT via token paymaster)
recovery/
  personal-guardian/
    01-add-personal-guardian/           # enable module, add 2 guardians (threshold 2)
    02-recovery-flow-personal-guardian/ # guardian sigs → execute → grace period → finalize
  email-sms/
    01-enable-email-sms-recovery/       # deploy safe, register channels, add Candide guardian
    02-recovery-flow-email-sms/         # OTP verify → execute → grace period → finalize
  shared/
    setup-alerts/                       # subscribe to recovery event notifications
    cancel-recovery/                    # owner cancels a pending recovery
dist/                                   # compiled output (gitignored)
```

Each example folder contains:
- `index.ts` — standalone script

A single `.env.example` at the project root covers all variables across all examples.

## TypeScript / Module Setup

The project uses **ES Modules** (`"type": "module"` in package.json) with `"module": "NodeNext"` in tsconfig, required because WDK is ESM-only. Relative imports within the project must use `.js` extensions (TypeScript ESM convention). External package imports need no extension.

## Architectural Pattern for WDK + abstractionkit

The two libraries have complementary roles:

| Concern | Library |
|---|---|
| Account creation & key management | WDK (`WalletManagerEvmErc4337`) |
| Transaction signing & UserOp submission | WDK (`account.sendTransaction()`) |
| Gas estimation & paymaster integration | WDK (configured in `WalletManagerEvmErc4337`) |
| Social recovery meta-transactions | abstractionkit (`SocialRecoveryModule`) |
| On-chain state queries (guardians, etc.) | abstractionkit (`SocialRecoveryModule`) |
| Polling for UserOp inclusion | abstractionkit (`Bundler.getUserOperationReceipt()`) |

**Integration flow:**
1. Create `WalletManagerEvmErc4337` from a BIP-39 seed phrase
2. Call `wallet.getAccount(index)` → `account.getAddress()` to get the Safe address
3. Use abstractionkit's module classes (e.g. `SocialRecoveryModule`) to build `MetaTransaction` objects `{to, value, data}`
4. Pass those transactions to `account.sendTransaction([tx1, tx2])` — WDK handles the rest
5. Poll `Bundler.getUserOperationReceipt(hash)` (returns `null` until included) to wait for onchain confirmation
6. Call `account.dispose()` and `wallet.dispose()` when done to clear keys from memory

## WDK Gas Payment Modes

`WalletManagerEvmErc4337` supports three gas payment modes via its config:

- **Sponsorship** (`isSponsored: true` + `paymasterUrl`): Candide paymaster sponsors gas — no pre-funding required. Best for examples.
- **Paymaster token** (`paymasterToken`, `paymasterUrl`, `paymasterAddress`): Gas paid in an ERC-20 (e.g. USDT).
- **Native coins** (`useNativeCoins: true`): Gas paid in ETH; account must hold ETH.

## SocialRecoveryModule Grace Periods

`SocialRecoveryModule` defaults to the **3-day grace period** contract. Other variants are exposed as `SocialRecoveryModuleGracePeriodSelector` enum values (3 minutes for testing, 3/7/14 days for production).

## MetaTransaction Compatibility

abstractionkit's `MetaTransaction` `{to, value, data, operation?}` and WDK's `EvmTransaction` `{to, value, data}` are structurally compatible. The `operation` field is ignored by WDK (it always uses CALL). Pass the array directly to `account.sendTransaction()`.
