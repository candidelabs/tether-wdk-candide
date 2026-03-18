---
name: integrate-passkeys
description: Use when a developer wants to add passkey or WebAuthn signing to a WDK-managed Safe smart account, integrate P-256 passkeys as Safe owners, or send UserOperations signed by a passkey alongside an existing EOA signer.
---

You are helping a developer add **passkey (WebAuthn / P-256) signing** to a Safe smart account managed by **WDK (Tether Wallet Development Kit)**.

This repository contains a reference implementation. Always read the example files before writing any code — they are the source of truth.

## Reference implementation

```
multisig-passkey/
  index.ts      # full flow: WDK setup + passkey owner + passkey-signed UserOp
  webauthn.ts   # simulated WebAuthn for Node.js (replace with navigator.credentials in browser)
```

Run: `npm run send-userop-passkey-multisig`

## Why two libraries?

WDK cannot sign with passkeys — its `sendTransaction()` always signs with the seed-phrase-derived EOA key internally. For passkey-signed UserOps, use abstractionkit's manual UserOp flow.

| Concern | Library |
|---------|---------|
| Safe creation from seed phrase | WDK (`WalletManagerEvmErc4337`) |
| Safe deployment + EOA-signed transactions | WDK (`account.sendTransaction()`) |
| Gas sponsorship (EOA path) | WDK (configured via `isSponsored` + `paymasterUrl`) |
| Deploy WebAuthn verifier contract | abstractionkit (`SafeAccount.createDeployWebAuthnVerifierMetaTransaction`) |
| Add passkey as Safe owner | abstractionkit (`safeAccount.createStandardAddOwnerWithThresholdMetaTransaction`) |
| Derive passkey verifier address | abstractionkit (`SafeAccount.createWebAuthnSignerVerifierAddress`) |
| Build passkey-signed UserOps | abstractionkit (`safeAccount.createUserOperation`) |
| Gas sponsorship (passkey path) | abstractionkit (`CandidePaymaster.createSponsorPaymasterUserOperation`) |
| Sign UserOp with passkey | abstractionkit (`SafeAccount.getUserOperationEip712Hash` + `createWebAuthnSignature` + `formatSignaturesToUseroperationSignature`) |
| Submit passkey-signed UserOps | abstractionkit (`safeAccount.sendUserOperation`) |

## Integration flow

### Phase A: Setup (WDK submits, abstractionkit builds meta-transactions)

```typescript
// 1. WDK creates the Safe
const wallet = new WalletManagerEvmErc4337(seedPhrase, { ...config, isSponsored: true })
const account = await wallet.getAccount(0)
const accountAddress = await account.getAddress()

// 2. Create passkey (browser: navigator.credentials.create, Node: WebAuthnCredentials shim)
const passkeyPublicKey: WebauthnPublicKey = { x: publicKey.x, y: publicKey.y }

// 3. abstractionkit builds the meta-transactions
const deployVerifierTx = SafeAccount.createDeployWebAuthnVerifierMetaTransaction(
    passkeyPublicKey.x, passkeyPublicKey.y,
)
const passkeyVerifierAddress = SafeAccount.createWebAuthnSignerVerifierAddress(
    passkeyPublicKey.x, passkeyPublicKey.y,
)
const safeAccount = new SafeAccount(accountAddress)
const addOwnerTx = safeAccount.createStandardAddOwnerWithThresholdMetaTransaction(
    passkeyVerifierAddress, 1, // threshold: 1 = either owner can sign
)

// 4. WDK batches into single UserOp (deploys Safe + verifier + adds owner)
await account.sendTransaction([deployVerifierTx, addOwnerTx])
```

### Phase B: Passkey-signed UserOp (abstractionkit handles everything)

```typescript
// 5. Build unsigned UserOp
let userOperation = await safeAccount.createUserOperation(
    [transaction], nodeUrl, bundlerUrl,
    { expectedSigners: [passkeyPublicKey] },
)

// 6. Sponsor gas (same Candide paymaster service WDK uses internally)
const paymaster = new CandidePaymaster(paymasterUrl)
const [sponsoredUserOp] = await paymaster.createSponsorPaymasterUserOperation(
    userOperation, bundlerUrl, sponsorshipPolicyId,
)
userOperation = sponsoredUserOp

// 7. Sign with passkey
const userOpHash = SafeAccount.getUserOperationEip712Hash(userOperation, chainId)
// In browser: navigator.credentials.get({ publicKey: { challenge: hash } })
// Extract: authenticatorData, clientDataFields, rs (r,s signature components)
const webauthnSignature = SafeAccount.createWebAuthnSignature(signatureData)
userOperation.signature = SafeAccount.formatSignaturesToUseroperationSignature(
    [{ signer: passkeyPublicKey, signature: webauthnSignature }],
)

// 8. Submit
const response = await safeAccount.sendUserOperation(userOperation, bundlerUrl)
const receipt = await response.included()
```

## Critical patterns

### 1. Use `createStandardAddOwnerWithThresholdMetaTransaction` for counterfactual Safes
`createAddOwnerWithThresholdMetaTransactions` queries the chain for current owners — it fails if the Safe isn't deployed yet. The `Standard` variant takes a plain address and encodes the calldata without chain queries, so it works in a batched UserOp that also deploys the Safe:

```typescript
// Works even if Safe is not yet deployed (counterfactual)
const addOwnerTx = safeAccount.createStandardAddOwnerWithThresholdMetaTransaction(
    passkeyVerifierAddress, 1,
)
```

### 2. Verifier address is deterministic
The verifier contract address is derived from the passkey's public key coordinates — no deployment needed to compute it:

```typescript
const verifierAddress = SafeAccount.createWebAuthnSignerVerifierAddress(x, y)
```

### 3. `expectedSigners` is required for gas estimation with passkeys
WebAuthn dummy signatures are larger than ECDSA ones. Without `expectedSigners`, gas estimation uses ECDSA-sized dummies and the UserOp may revert:

```typescript
await safeAccount.createUserOperation([tx], nodeUrl, bundlerUrl, {
    expectedSigners: [passkeyPublicKey],  // tells estimator to use WebAuthn dummy sig
})
```

### 4. Browser vs Node.js
The WebAuthn ceremony (`navigator.credentials.create/get`) is a browser API. For Node.js examples, use the simulated `WebAuthnCredentials` shim from `multisig-passkey/webauthn.ts`. The on-chain verification is identical — the P-256 verifier contract doesn't know or care whether the signature came from hardware or software.

### 5. Always dispose WDK objects when done
```typescript
account.dispose()
wallet.dispose()
```

## Key types

```typescript
import { WebauthnPublicKey, WebauthnSignatureData, SignerSignaturePair } from 'abstractionkit'

// Passkey public key (P-256 coordinates)
const passkeyPublicKey: WebauthnPublicKey = { x: bigint, y: bigint }

// WebAuthn assertion result (from navigator.credentials.get)
const signatureData: WebauthnSignatureData = {
    authenticatorData: ArrayBuffer,
    clientDataFields: string,   // hex-encoded extra client data fields
    rs: [bigint, bigint],       // ECDSA r,s components from DER signature
}

// Signer + signature pair for formatSignaturesToUseroperationSignature
const pair: SignerSignaturePair = {
    signer: passkeyPublicKey,   // WebauthnPublicKey | string (EOA address)
    signature: string,          // hex-encoded signature
}
```

## Threshold options

| Setup | Threshold | Behavior |
|-------|-----------|----------|
| 1-of-2 (recommended for this example) | 1 | Either EOA or passkey can sign independently |
| 2-of-2 | 2 | Both must sign every transaction (fragile — lose one key = stuck) |
| 2-of-3 | 2 | Add a third signer for redundancy |

The reference implementation uses **1-of-2**: WDK EOA + passkey, threshold 1.

## How to help the developer

1. **Read `multisig-passkey/index.ts`** before writing any code — it is the source of truth
2. **Determine their starting point** — do they already have a WDK-managed Safe, or starting fresh?
3. **Phase A adapts easily** — if they already have a deployed Safe, skip the deployment part and just batch `deployVerifierTx + addOwnerTx` via `account.sendTransaction()`
4. **Phase B is the reusable pattern** — the `signUserOperationWithPasskey()` function in the reference implementation is the core pattern for any passkey-signed UserOp
5. **Browser integration** — if they're building a web app, replace `WebAuthnCredentials` with `navigator.credentials` and the `extractPublicKey/extractSignature/extractClientDataFields` helpers with their browser equivalents
6. **Point to the npm script** for running the example: `npm run send-userop-passkey-multisig`
