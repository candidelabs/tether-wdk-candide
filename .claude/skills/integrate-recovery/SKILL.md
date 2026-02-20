You are helping a developer integrate **Candide Social Recovery** into a Safe smart account wallet built with **WDK (Tether Wallet Development Kit)**.

This repository contains reference implementations for every step. Always read the relevant example files before writing any code — they are the source of truth.

## Repo structure

```
recovery/
  personal-guardian/
    01-add-personal-guardian/           # enable SRM + add 2 guardians (threshold 2)
    02-recovery-flow-personal-guardian/ # guardian sigs → execute → grace period → finalize
  email-sms/
    01-enable-email-sms-recovery/       # deploy safe + register email/SMS + add Candide guardian
    02-recovery-flow-email-sms/         # OTP verify → execute → grace period → finalize
  shared/
    setup-alerts/                       # subscribe to recovery event notifications (gasless)
    cancel-recovery/                    # cancel a pending recovery (works with either path)
```

## Two recovery paths

| Path | Guardian | Auth |
|------|----------|------|
| Personal guardian | EOA wallets (trusted contacts) | EIP-712 signatures collected off-chain via `RecoveryByGuardian` |
| Email / SMS | Candide Guardian Service | OTP verification via `RecoveryByCustodialGuardian` |

Both paths use the same on-chain Safe Social Recovery Module. The difference is who signs and how they prove identity.

## Library responsibilities

| Concern | Library |
|---------|---------|
| Account creation, signing, UserOp submission | WDK (`WalletManagerEvmErc4337`) |
| SRM meta-transactions + on-chain queries | abstractionkit (`SocialRecoveryModule`, `SafeAccountV0_3_0`) |
| Off-chain recovery coordination + OTP | safe-recovery-service-sdk (`RecoveryByGuardian`, `RecoveryByCustodialGuardian`) |
| Alert subscriptions | safe-recovery-service-sdk (`Alerts`) |

## Critical patterns to always follow

### 1. Check before enabling the module
Before sending `createEnableModuleMetaTransaction`, always check if the module is already enabled — sending it twice reverts on-chain:

```typescript
const safeAccount = new SafeAccountV0_3_0(accountAddress)
const moduleAlreadyEnabled = await safeAccount.isModuleEnabled(nodeUrl, srm.moduleAddress)
if (!moduleAlreadyEnabled) {
  transactions.push(srm.createEnableModuleMetaTransaction(accountAddress))
}
```

If the Safe is counterfactual (not yet deployed), `isModuleEnabled` returns false — safe to proceed.

### 2. Grace period selector must match across all examples
Each `SocialRecoveryModuleGracePeriodSelector` value maps to a **different contract address**. Setup and recovery must use the same selector or recovery will target the wrong contract:

```typescript
// Use After3Minutes for testing, After7Days for production
const srm = new SocialRecoveryModule(SocialRecoveryModuleGracePeriodSelector.After3Minutes)
```

### 3. Batch transactions into one UserOperation
WDK supports multiple meta-transactions in a single UserOp. Use this to atomically enable the module and add guardians in one bundler round-trip:

```typescript
await account.sendTransaction([enableModuleTx, addGuardian1Tx, addGuardian2Tx])
```

### 4. Always print the seed phrase and keys at the end of setup examples
Developers need these values for follow-up examples (recovery flow, alerts, cancel):

```typescript
console.log(`  SEED_PHRASE="${seedPhrase}"`)
console.log(`  SAFE_ACCOUNT_ADDRESS=${accountAddress}`)
```

### 5. SEED_PHRASE is required (not generated) in setup-alerts and cancel-recovery
It must be the same phrase used in example 01 — it derives the owner address that is authorized for the Safe. Never generate a new one in these scripts.

### 6. New owner key must be saved before recovery completes
Both recovery flow examples generate (or accept) a new owner key. If generated, print the private key prominently with a warning before the script proceeds:

```typescript
console.log(`⚠️  NEW OWNER KEY GENERATED — SAVE THIS BEFORE CONTINUING`)
console.log(`   Private key: ${newOwnerPrivateKey}`)
```

### 7. SIWE signing: EOA vs EIP-1271
- Registration with the guardian service (example 01 email/SMS) requires **EIP-1271** Safe contract signatures — the service verifies the Safe account is authorizing the action
- Alert subscriptions use **plain EOA signing** — the service verifies the owner EOA directly
- Comments in each example explain which is used and why

### 8. Always dispose WDK objects when done
```typescript
account.dispose()
wallet.dispose()
```

## Key API reference

### SocialRecoveryModule (abstractionkit)
```typescript
const srm = new SocialRecoveryModule(SocialRecoveryModuleGracePeriodSelector.After3Minutes)
srm.moduleAddress                                          // contract address
srm.createEnableModuleMetaTransaction(safeAddress)
srm.createAddGuardianWithThresholdMetaTransaction(guardian, threshold)
srm.createCancelRecoveryMetaTransaction()                  // no args — Safe is always the caller
srm.getRecoveryRequest(nodeUrl, safeAddress)               // { executeAfter, newOwners, newThreshold }
srm.isGuardian(nodeUrl, safeAddress, guardianAddress)
srm.threshold(nodeUrl, safeAddress)
srm.getRecoveryRequestEip712Data(nodeUrl, chainId, safeAddress, newOwners, newThreshold)
```

### SafeAccountV0_3_0 (abstractionkit)
```typescript
const safe = new SafeAccountV0_3_0(safeAddress)
safe.isModuleEnabled(nodeUrl, moduleAddress)
safe.getOwners(nodeUrl)
SafeAccountV0_3_0.buildSignaturesFromSingerSignaturePairs([{ signer, signature }])
```

### WalletManagerEvmErc4337 (WDK)
```typescript
const wallet = new WalletManagerEvmErc4337(seedPhrase, {
  chainId, provider, bundlerUrl, entryPointAddress,
  safeModulesVersion: '0.3.0',
  isSponsored: true, paymasterUrl, sponsorshipPolicyId,
})
const account = await wallet.getAccount(0)
const address = await account.getAddress()
const result = await account.sendTransaction([tx1, tx2])  // result.hash
```

### Waiting for UserOp confirmation
```typescript
const bundler = new Bundler(bundlerUrl)
const response = new SendUseroperationResponse(hash, bundler, entryPointAddress)
const receipt = await response.included()  // receipt.success, receipt.receipt.transactionHash
```

## How to help the developer

1. **Ask which path they want** — personal guardian or email/SMS — if not specified
2. **Read the relevant example files** before writing any code
3. **Walk through the examples in order**: setup (01) → recovery flow (02) → shared utilities
4. **Adapt the examples** to the developer's existing codebase — they may already have WDK initialized, different env var names, etc.
5. **Call out the critical patterns** above whenever relevant, especially the module-already-enabled check and the grace period consistency requirement
6. **Point to the npm scripts** for running examples: `npm run add-personal-guardian`, `npm run enable-email-sms-recovery`, `npm run setup-alerts`, `npm run cancel-recovery`, etc.

$ARGUMENTS
