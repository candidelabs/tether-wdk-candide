/**
 * Passkey as Second Owner (1-of-2 Multisig)
 *
 * Demonstrates adding a passkey as a second owner to a WDK-managed Safe,
 * then sending a UserOperation signed solely by the passkey.
 *
 * Flow:
 *   Phase A — Setup (uses WDK for Safe creation + transaction submission):
 *     1. WDK creates a Safe smart account from a seed phrase
 *     2. A simulated passkey (P-256) credential is generated
 *     3. abstractionkit builds meta-transactions to deploy the WebAuthn
 *        verifier and add the passkey as a Safe owner
 *     4. WDK batches everything into a single UserOp (deploys Safe + adds passkey)
 *
 *   Phase B — Passkey-signed UserOp (uses abstractionkit directly):
 *     WDK's sendTransaction() always signs with the EOA key, so to sign
 *     with a passkey we use abstractionkit's manual UserOp flow:
 *     5. Build an unsigned UserOperation
 *     6. Sponsor gas via CandidePaymaster
 *     7. Sign with the passkey
 *     8. Submit to the bundler
 *
 * Why two libraries?
 *   - WDK: manages the Safe lifecycle (creation from seed phrase, deployment,
 *     gas sponsorship, EOA-signed transactions)
 *   - abstractionkit: provides passkey/WebAuthn support (verifier deployment,
 *     owner management, passkey-signed UserOps, signature formatting)
 *
 * Note: This example uses a simulated WebAuthn implementation for Node.js.
 * In a real browser application, replace the WebAuthnCredentials shim with
 * the native navigator.credentials API. The on-chain verification is identical.
 *
 * Required env vars (see .env.example):
 *   CHAIN_ID, NODE_URL, BUNDLER_URL, PAYMASTER_URL,
 *   ENTRY_POINT_ADDRESS
 *
 * Optional env vars:
 *   SEED_PHRASE — BIP-39 seed phrase (generated if not provided)
 *
 * Run: npm run send-userop-passkey-multisig
 */

import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import {
    Bundler,
    CandidePaymaster,
    SafeAccountV0_3_0 as SafeAccount,
    SendUseroperationResponse,
    UserOperationV7,
    WebauthnPublicKey,
    WebauthnSignatureData,
    SignerSignaturePair,
    MetaTransaction,
} from 'abstractionkit'
import * as dotenv from 'dotenv'
import { generateMnemonic, english } from 'viem/accounts'
import { hexToBytes, keccak256, toBytes } from 'viem'

import {
    UserVerificationRequirement,
    WebAuthnCredentials,
    extractClientDataFields,
    extractPublicKey,
    extractSignature,
} from './webauthn.js'

// ============================================================================
// Helpers
// ============================================================================

function printSection(title: string) {
    console.log('\n' + '='.repeat(60))
    console.log(`  ${title}`)
    console.log('='.repeat(60))
}

async function waitForUserOperation(
    userOperationHash: string,
    bundlerUrl: string,
    entryPointAddress: string,
) {
    const bundler = new Bundler(bundlerUrl)
    const response = new SendUseroperationResponse(userOperationHash, bundler, entryPointAddress)
    return response.included()
}

/**
 * Sign a UserOperation with a passkey and format the signature for Safe.
 *
 * This is the core pattern for passkey-signed UserOps:
 *   1. Compute the EIP-712 hash of the UserOperation
 *   2. Present the hash as a WebAuthn challenge for the passkey to sign
 *   3. Extract the signature components (authenticatorData, clientDataFields, r, s)
 *   4. Format them into a Safe-compatible UserOperation signature
 *
 * In a browser, step 2 would trigger a biometric prompt via navigator.credentials.get().
 * Here we use the simulated WebAuthnCredentials shim.
 */
function signUserOperationWithPasskey(
    userOperation: UserOperationV7,
    chainId: bigint,
    passkeyPublicKey: WebauthnPublicKey,
    credentials: WebAuthnCredentials,
    credentialRawId: ArrayBuffer,
): string {
    // 1. Get the EIP-712 hash — this is what the passkey signs
    const userOpHash = SafeAccount.getUserOperationEip712Hash(
        userOperation,
        chainId,
    )

    // 2. Present as WebAuthn challenge (biometric prompt in a real browser)
    const assertion = credentials.get({
        publicKey: {
            challenge: hexToBytes(userOpHash as `0x${string}`),
            rpId: 'candide.dev',
            allowCredentials: [{
                type: 'public-key',
                id: new Uint8Array(credentialRawId),
            }],
            userVerification: UserVerificationRequirement.required,
        },
    })

    // 3. Extract signature components from the WebAuthn response
    const signatureData: WebauthnSignatureData = {
        authenticatorData: assertion.response.authenticatorData,
        clientDataFields: extractClientDataFields(assertion.response),
        rs: extractSignature(assertion.response),
    }

    // 4. Format into a Safe-compatible signature
    const webauthnSignature = SafeAccount.createWebAuthnSignature(signatureData)

    const signerSignaturePair: SignerSignaturePair = {
        signer: passkeyPublicKey,
        signature: webauthnSignature,
    }

    return SafeAccount.formatSignaturesToUseroperationSignature(
        [signerSignaturePair],
        { isInit: userOperation.nonce == 0n }
    )
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    dotenv.config()

    console.log('\n' + '='.repeat(60))
    console.log('  Passkey as Second Owner (1-of-2)')
    console.log('='.repeat(60))

    // -----------------------------------------------------------------------
    // Load Configuration
    // -----------------------------------------------------------------------
    printSection('Configuration')

    const requiredEnvVars = [
        'CHAIN_ID', 'NODE_URL', 'BUNDLER_URL', 'PAYMASTER_URL',
        'ENTRY_POINT_ADDRESS',
    ]
    const missing = requiredEnvVars.filter(v => !process.env[v])
    if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(', ')}`)
    }

    const seedPhrase = process.env.SEED_PHRASE || generateMnemonic(english) as string
    const chainId = Number(process.env.CHAIN_ID)
    const nodeUrl = process.env.NODE_URL as string
    const bundlerUrl = process.env.BUNDLER_URL as string
    const paymasterUrl = process.env.PAYMASTER_URL as string
    const entryPointAddress = process.env.ENTRY_POINT_ADDRESS as string
    const sponsorshipPolicyId = process.env.SPONSORSHIP_POLICY_ID as string

    console.log(`Chain ID: ${chainId}`)
    console.log(`Bundler:  ${bundlerUrl}`)

    // =======================================================================
    // PHASE A: WDK creates Safe + adds passkey as second owner
    //
    // WDK handles the full lifecycle here: Safe creation from seed phrase,
    // counterfactual deployment, gas sponsorship, and EOA-signed submission.
    // abstractionkit provides the meta-transactions for passkey setup.
    // =======================================================================

    // -----------------------------------------------------------------------
    // Step 1: Create Safe Account via WDK
    // -----------------------------------------------------------------------
    printSection('Step 1: Create Safe Account (WDK)')

    const wallet = new WalletManagerEvmErc4337(seedPhrase, {
        chainId,
        provider: nodeUrl,
        bundlerUrl,
        entryPointAddress,
        safeModulesVersion: '0.3.0',
        isSponsored: true,
        paymasterUrl,
        sponsorshipPolicyId,
    })

    const account = await wallet.getAccount(0)
    const accountAddress = await account.getAddress()

    console.log(`Safe Account: ${accountAddress}`)

    // -----------------------------------------------------------------------
    // Step 2: Create Passkey
    // -----------------------------------------------------------------------
    printSection('Step 2: Create Passkey')

    // In a browser, this would be: navigator.credentials.create(...)
    // The simulated shim generates a real P-256 keypair using Node.js crypto.
    const credentials = new WebAuthnCredentials()

    const credential = credentials.create({
        publicKey: {
            rp: { name: 'Safe', id: 'safe.global' },
            user: {
                id: hexToBytes(keccak256(toBytes('passkey-demo'))),
                name: 'passkey-demo',
                displayName: 'Passkey Demo',
            },
            challenge: hexToBytes(keccak256(toBytes(String(Date.now())))),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        },
    })

    const publicKey = extractPublicKey(credential.response)
    const passkeyPublicKey: WebauthnPublicKey = {
        x: publicKey.x,
        y: publicKey.y,
    }

    // The verifier address is deterministic — derived from the passkey's public key
    const passkeyVerifierAddress = SafeAccount.createWebAuthnSignerVerifierAddress(
        passkeyPublicKey.x,
        passkeyPublicKey.y,
    )

    console.log(`Passkey public key x: ${passkeyPublicKey.x}`)
    console.log(`Passkey public key y: ${passkeyPublicKey.y}`)
    console.log(`Passkey verifier:     ${passkeyVerifierAddress}`)

    // -----------------------------------------------------------------------
    // Step 3: Add Passkey as Safe Owner (single batched UserOp via WDK)
    // -----------------------------------------------------------------------
    printSection('Step 3: Add Passkey Owner')

    // abstractionkit builds the meta-transactions, WDK submits them.
    // Two things happen in one UserOp:
    //   1. Deploy the on-chain P-256 signature verifier for this passkey
    //   2. Register the verifier address as a Safe owner (threshold stays at 1)
    const deployVerifierTx: MetaTransaction = SafeAccount.createDeployWebAuthnVerifierMetaTransaction(
        passkeyPublicKey.x,
        passkeyPublicKey.y,
    )

    const safeAccount = new SafeAccount(accountAddress)
    const addOwnerTx: MetaTransaction = safeAccount.createStandardAddOwnerWithThresholdMetaTransaction(
        passkeyVerifierAddress,
        1, // threshold stays at 1 — either owner can sign independently
    )

    console.log('Submitting via WDK (single UserOp: deploy Safe + deploy verifier + add owner)...')

    // WDK batches both meta-transactions into one UserOp. If the Safe hasn't
    // been deployed yet (counterfactual), WDK deploys it as part of this UserOp.
    const setupResult = await account.sendTransaction([deployVerifierTx, addOwnerTx])
    console.log(`UserOp hash: ${setupResult.hash}`)

    console.log('Waiting for on-chain confirmation...')
    const setupReceipt = await waitForUserOperation(setupResult.hash, bundlerUrl, entryPointAddress)

    if (!setupReceipt.success) {
        throw new Error(`Setup UserOp failed. Tx: ${setupReceipt.receipt.transactionHash}`)
    }
    console.log(`Confirmed: ${setupReceipt.receipt.transactionHash}`)

    // Verify the passkey was added as an owner
    const owners = await safeAccount.getOwners(nodeUrl)
    console.log(`\nOwners (${owners.length}):`)
    for (const owner of owners) {
        const label = owner.toLowerCase() === passkeyVerifierAddress.toLowerCase()
            ? ' (passkey)'
            : ' (WDK EOA)'
        console.log(`  ${owner}${label}`)
    }

    // =======================================================================
    // PHASE B: Send a UserOp signed only by the passkey
    //
    // WDK's sendTransaction() always signs with the EOA key internally,
    // so to sign with a passkey we use abstractionkit's manual UserOp flow:
    // build → sponsor → sign → submit
    // =======================================================================

    // -----------------------------------------------------------------------
    // Step 4: Build + Sponsor UserOperation
    // -----------------------------------------------------------------------
    printSection('Step 4: Build Passkey-Signed UserOp')

    // A simple 0-value call to self — replace with any contract interaction.
    const transaction: MetaTransaction = {
        to: accountAddress,
        value: 0n,
        data: '0x',
    }

    // Build the unsigned UserOp. expectedSigners tells the gas estimator
    // to use a WebAuthn dummy signature (different size than ECDSA).
    console.log('Building UserOperation...')
    let userOperation = await safeAccount.createUserOperation(
        [transaction],
        nodeUrl,
        bundlerUrl,
        {
            expectedSigners: [passkeyPublicKey],
        },
    )

    // Sponsor gas via Candide paymaster (same service WDK uses internally)
    console.log('Requesting paymaster sponsorship...')
    const paymaster = new CandidePaymaster(paymasterUrl)
    const [sponsoredUserOp] = await paymaster.createSponsorPaymasterUserOperation(
        userOperation,
        bundlerUrl,
        sponsorshipPolicyId,
    )
    userOperation = sponsoredUserOp

    // -----------------------------------------------------------------------
    // Step 5: Sign with Passkey + Submit
    // -----------------------------------------------------------------------
    printSection('Step 5: Sign + Submit')

    userOperation.signature = signUserOperationWithPasskey(
        userOperation,
        BigInt(chainId),
        passkeyPublicKey,
        credentials,
        credential.rawId,
    )
    console.log('Passkey signature applied')

    console.log('Sending UserOperation...')
    const sendResponse = await safeAccount.sendUserOperation(userOperation, bundlerUrl)

    console.log(`UserOp hash: ${sendResponse.userOperationHash}`)
    console.log('Waiting for on-chain confirmation...')

    const txReceipt = await sendResponse.included()

    if (!txReceipt.success) {
        throw new Error(`UserOp failed. Tx: ${txReceipt.receipt.transactionHash}`)
    }

    console.log(`Confirmed: ${txReceipt.receipt.transactionHash}`)

    // -----------------------------------------------------------------------
    // Done
    // -----------------------------------------------------------------------
    printSection('Done')

    console.log('The Safe now has two owners (1-of-2 threshold):')
    console.log('  - WDK EOA (signs via seed phrase)')
    console.log('  - Passkey (signs via WebAuthn / P-256)')
    console.log('')
    console.log('Either owner can independently sign transactions.')
    console.log('Phase A used WDK to set up the Safe and add the passkey owner.')
    console.log('Phase B used abstractionkit to send a UserOp signed only by the passkey.')

    account.dispose()
    wallet.dispose()
}

// ============================================================================
// Run
// ============================================================================

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\nError:', error instanceof Error ? error.message : error)
        process.exit(1)
    })
