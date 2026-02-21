# WDK + Candide Integration Examples

Reference examples for integrating [Candide](https://candide.dev) with [WDK](https://github.com/tetherto/lib-wallet) to build ERC-4337 Smart Account wallets.

## Getting Started

```bash
npm install
cp .env.example .env   # fill in your RPC, bundler, and paymaster URLs
```

Credentials available from [dashboard.candide.dev](https://dashboard.candide.dev). Each example reads from `.env` and can be run directly with `tsx` — no build step needed.

---

## Examples

### Send UserOperation

| Script | Gas mode | Command |
|--------|----------|---------|
| `send-userop/01-sponsored-gas` | Sponsored — paymaster covers all gas | `npm run send-userop-sponsored` |
| `send-userop/02-erc20-gas` | ERC-20 (USDT) — gas deducted from token balance | `npm run send-userop-erc20` |

> Get test USDT on Sepolia at [dashboard.candide.dev/faucet](https://dashboard.candide.dev/faucet)

### Recovery

Social recovery transfers Safe ownership to a new key via trusted guardians. Two guardian paths are available:

**Personal Guardian** — EOA wallets you control

| Step | Command |
|------|---------|
| Enable module + add guardians | `npm run add-personal-guardian` |
| Run full recovery flow | `npm run recovery-flow-personal-guardian` |

**Email / SMS** — Candide verifies identity via OTP before co-signing

| Step | Command |
|------|---------|
| Deploy Safe + register channels | `npm run enable-email-sms-recovery` |
| Run full recovery flow | `npm run recovery-flow-email-sms` |

**Shared utilities** (work with either path)

| Command | Description |
|---------|-------------|
| `npm run setup-alerts` | Subscribe to recovery event notifications |
| `npm run cancel-recovery` | Cancel a pending recovery during the grace period |

---

## Key Concepts

**Grace period** — after a recovery executes on-chain, the original owner has a window to cancel before it finalises. These examples use `After3Minutes` for testing; use `After3Days` / `After7Days` / `After14Days` for production. The setup and recovery flow scripts must use the **same** selector.

**WDK + abstractionkit** — abstractionkit builds the calldata (`{to, value, data}`); WDK wraps it into a UserOperation, signs it, and submits it to the bundler.
