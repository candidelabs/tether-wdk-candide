# WDK + Candide Integration Examples

Reference examples for integrating [Candide](https://candide.dev) plugins and services with [WDK (Wallet Development Kit)](https://github.com/tetherto/lib-wallet) to build Smart Account wallets on ERC-4337.

## What's Here

Each example is a self-contained TypeScript script demonstrating one step of a real integration. Run them in order to walk through a complete flow.

**Libraries used across all examples:**

| Library | Role |
|---------|------|
| `@tetherto/wdk-wallet-evm-erc-4337` | Manages Safe smart accounts from BIP-39 seed phrases. Handles ERC-4337 UserOperation creation, signing, and submission. |
| `abstractionkit` | Candide's SDK. Builds meta-transactions for the Social Recovery Module and queries on-chain state. |
| `safe-recovery-service-sdk` | Candide's off-chain recovery service client. Coordinates guardian signatures and OTP verification. |

---

## Recovery

Social recovery lets trusted guardians transfer ownership of a Safe to a new key when the original owner loses access. Two paths are available:

| Path | Guardians | Best For |
|------|-----------|----------|
| [Personal Guardian](#personal-guardian) | EOA wallets you control, or trusted contacts | Full self-custody, no third-party dependency |
| [Email / SMS](#emailsms-custodial-guardian) | Candide Guardian Service | Simpler UX — identity verified via OTP |

Both paths use the same on-chain [Safe Social Recovery Module](https://github.com/candide-eu/safe-recovery-module). The difference is who acts as guardian and how they authenticate.

---

### Personal Guardian

Set up one or more EOA wallets as guardians. Recovery requires collecting signatures from enough guardians to meet the threshold.

| Step | Script | Description |
|------|--------|-------------|
| 01 | `recovery/personal-guardian/01-add-personal-guardian` | Enable Social Recovery Module and add two guardians (threshold 2) |
| 02 | `recovery/personal-guardian/02-recovery-flow-personal-guardian` | Execute a full recovery: guardians sign, recovery executes, grace period, finalize |

```bash
npm run add-personal-guardian
npm run recovery-flow-personal-guardian
```

---

### Email / SMS (Custodial Guardian)

Candide acts as a guardian. When recovery is requested, Candide verifies your identity via email/SMS OTP before signing the recovery transaction.

| Step | Script | Description |
|------|--------|-------------|
| 01 | `recovery/email-sms/01-enable-email-sms-recovery` | Deploy Safe, register email/SMS channels, add Candide as on-chain guardian |
| 02 | `recovery/email-sms/02-recovery-flow-email-sms` | Execute a full recovery via OTP verification |

```bash
npm run enable-email-sms-recovery
npm run recovery-flow-email-sms
```

---

### Shared utilities

These work with **either** recovery path.

| Script | Description |
|--------|-------------|
| `recovery/shared/setup-alerts` | Subscribe to email/SMS notifications for recovery events (gasless) |
| `recovery/shared/cancel-recovery` | Cancel a pending recovery during the grace period |

```bash
npm run setup-alerts
npm run cancel-recovery
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Sepolia testnet RPC, bundler, and paymaster URLs (available from your Candide dashboard)
- For email/SMS examples: a Candide Recovery Service URL

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
# Fill in your values — see comments in .env.example
```

---

## Key Concepts

### Grace Period

After a recovery is executed on-chain there is a mandatory waiting period before it can be finalized. During this window the **original owner can cancel** — this is the primary protection against malicious recovery attempts.

| Selector | Duration | Use Case |
|----------|----------|----------|
| `After3Minutes` | 3 min | Testing and demos (used in these examples) |
| `After3Days` | 3 days | Production minimum |
| `After7Days` | 7 days | Recommended for production |
| `After14Days` | 14 days | High-security wallets |

> **Important:** the grace period selector determines which SRM contract address is used. The setup example and the recovery flow example must use the **same** selector, or the recovery will target the wrong contract.

### How WDK and abstractionkit Work Together

```
WalletManagerEvmErc4337 (WDK)
  └─ getAccount(index)
       └─ account.sendTransaction([tx1, tx2, ...])
            └─ bundles meta-transactions into one UserOperation
                 └─ signs and submits via bundler

SocialRecoveryModule (abstractionkit)
  └─ createEnableModuleMetaTransaction()    → {to, value, data}
  └─ createAddGuardianWithThresholdMetaTransaction() → {to, value, data}
  └─ createCancelRecoveryMetaTransaction()  → {to, value, data}
  └─ getRecoveryRequest()                  → on-chain state query
```

abstractionkit builds the calldata; WDK wraps it in a UserOperation and pays for gas.

### SIWE Signing: EOA vs EIP-1271

Some off-chain service calls require a signature to prove account ownership. Two signing modes appear in these examples:

- **EIP-1271 (Safe contract signature)** — used when the service needs to verify the *Safe account* is the signer (e.g., registering recovery channels). The message is wrapped in Safe's EIP-712 format.
- **Plain EOA signature** — used when the service verifies the *owner EOA* directly (e.g., alert subscriptions). Simpler, no on-chain contract involved.

The signing method required depends on what the service endpoint expects. Comments in each example explain which is used and why.

---

## Project Structure

```
recovery/
  personal-guardian/
    01-add-personal-guardian/           # enable module + add 2 guardians
    02-recovery-flow-personal-guardian/ # collect guardian sigs + finalize
  email-sms/
    01-enable-email-sms-recovery/       # deploy safe + register channels
    02-recovery-flow-email-sms/         # OTP verify + finalize
  shared/
    setup-alerts/                       # subscribe to event notifications
    cancel-recovery/                    # cancel a pending recovery
dist/                                   # compiled output (gitignored)
.env.example                            # all variables across all examples
```
