/**
 * Passkey as Second Owner (1-of-2 Multisig)
 *
 * Demonstrates adding a passkey as a second owner to a WDK-managed Safe,
 * then sending a UserOperation signed solely by the passkey.
 *
 * Flow:
 *   Phase A — Setup (via WDK, threshold stays at 1):
 *     1. WDK creates and deploys a Safe smart account from a seed phrase
 *     2. A simulated passkey (P-256) credential is generated
 *     3. Passkey is added as a second Safe owner via abstractionkit's
 *        createAddOwnerWithThresholdMetaTransactions (deploys verifier + adds owner)
 *     4. Threshold stays at 1 — either owner can sign independently
 *
 *   Phase B — Passkey-signed UserOp (via abstractionkit):
 *     5. abstractionkit builds an unsigned UserOperation
 *     6. CandidePaymaster sponsors the gas
 *     7. The passkey signs the UserOp (no local key needed)
 *     8. UserOp is submitted and confirmed on-chain
 *
 * Libraries used:
 *   - WDK: Safe creation, initial owner setup, batched transaction submission
 *   - abstractionkit: Passkey owner management, UserOp construction, signing, submission
 *   - viem: Utility functions (hex encoding, hashing)
 *
 * Note: This example uses a simulated WebAuthn implementation for Node.js.
 * In a real browser application, replace the WebAuthnCredentials shim with
 * the native navigator.credentials API. The on-chain verification is identical.
 *
 * Required env vars (see .env.example):
 *   CHAIN_ID, NODE_URL, BUNDLER_URL, PAYMASTER_URL,
 *   ENTRY_POINT_ADDRESS, SPONSORSHIP_POLICY_ID
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
    WebauthnPublicKey,
    WebauthnSignatureData,
    SignerSignaturePair,
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
    // PHASE A: Setup — WDK creates Safe, adds passkey as second owner
    // =======================================================================

    // -----------------------------------------------------------------------
    // Step 1: Initialize Safe Account via WDK
    // -----------------------------------------------------------------------
    printSection('Phase A: Initialize Safe Account (WDK)')

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
    // Step 2: Create Simulated Passkey
    // -----------------------------------------------------------------------
    printSection('Phase A: Create Passkey')

    // In a browser, this would be: navigator.credentials.create(...)
    // The simulated shim generates a real P-256 keypair.
    const navigator = {
        credentials: new WebAuthnCredentials(),
    }

    const credential = navigator.credentials.create({
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
    const webauthPublicKey: WebauthnPublicKey = {
        x: publicKey.x,
        y: publicKey.y,
    }

    console.log(`Passkey public key x: ${webauthPublicKey.x}`)
    console.log(`Passkey public key y: ${webauthPublicKey.y}`)

    // -----------------------------------------------------------------------
    // Step 3: Deploy Safe
    // -----------------------------------------------------------------------
    printSection('Phase A: Deploy Safe')

    // The Safe must be deployed before we can add the passkey owner, because
    // createAddOwnerWithThresholdMetaTransactions queries the chain for current
    // owners. WDK deploys the Safe on the first sendTransaction call.
    console.log('Deploying Safe (first UserOp)...')
    const deployResult = await account.sendTransaction({
        to: accountAddress,
        value: 0n,
        data: '0x',
    })
    console.log(`UserOp hash: ${deployResult.hash}`)

    console.log('Waiting for on-chain confirmation...')
    const deployReceipt = await waitForUserOperation(deployResult.hash, bundlerUrl, entryPointAddress)

    if (!deployReceipt.success) {
        throw new Error(`Deploy UserOp failed. Tx: ${deployReceipt.receipt.transactionHash}`)
    }
    console.log(`Safe deployed: ${deployReceipt.receipt.transactionHash}`)

    // -----------------------------------------------------------------------
    // Step 4: Add Passkey as Owner
    // -----------------------------------------------------------------------
    printSection('Phase A: Add Passkey Owner')

    const safeAccount = new SafeAccount(accountAddress)

    // createAddOwnerWithThresholdMetaTransactions handles the full WebAuthn
    // setup: deploys the signer verifier contract and adds it as a Safe owner.
    const addPasskeyOwnerTxs = await safeAccount.createAddOwnerWithThresholdMetaTransactions(
        webauthPublicKey,
        1, // threshold stays at 1 — either owner can sign
        { nodeRpcUrl: nodeUrl },
    )

    console.log('Adding passkey as second owner...')

    const setupResult = await account.sendTransaction(addPasskeyOwnerTxs)
    console.log(`UserOp hash: ${setupResult.hash}`)

    // -----------------------------------------------------------------------
    // Step 5: Wait for Confirmation + Verify
    // -----------------------------------------------------------------------
    printSection('Phase A: Verify Setup')

    console.log('Waiting for on-chain confirmation...')
    const setupReceipt = await waitForUserOperation(setupResult.hash, bundlerUrl, entryPointAddress)

    if (!setupReceipt.success) {
        throw new Error(`Setup UserOp failed. Tx: ${setupReceipt.receipt.transactionHash}`)
    }
    console.log(`Confirmed: ${setupReceipt.receipt.transactionHash}`)

    // Verify the passkey was added as an owner
    const passkeyVerifierAddress = SafeAccount.createWebAuthnSignerVerifierAddress(
        webauthPublicKey.x,
        webauthPublicKey.y,
    )
    const owners = await safeAccount.getOwners(nodeUrl)
    console.log(`Owners (${owners.length}):`)
    for (const owner of owners) {
        const label = owner.toLowerCase() === passkeyVerifierAddress.toLowerCase()
            ? ' (passkey)'
            : ' (WDK EOA)'
        console.log(`  ${owner}${label}`)
    }

    // =======================================================================
    // PHASE B: Send UserOp signed by passkey only (via abstractionkit)
    // =======================================================================

    // -----------------------------------------------------------------------
    // Step 5: Build UserOperation
    // -----------------------------------------------------------------------
    printSection('Phase B: Build Passkey-Signed UserOp')

    // A simple no-op transaction — replace with any contract call.
    const transaction = {
        to: accountAddress,
        value: 0n,
        data: '0x' as string,
    }

    console.log('Building UserOperation via abstractionkit...')

    // createUserOperation handles nonce, gas estimation, and calldata encoding.
    // expectedSigners tells the gas estimator what dummy signatures to use.
    let userOperation = await safeAccount.createUserOperation(
        [transaction],
        nodeUrl,
        bundlerUrl,
        {
            expectedSigners: [webauthPublicKey],
        },
    )

    // -----------------------------------------------------------------------
    // Step 6: Sponsor Gas via Paymaster
    // -----------------------------------------------------------------------
    console.log('Requesting paymaster sponsorship...')

    const paymaster = new CandidePaymaster(paymasterUrl)
    const [sponsoredUserOp] = await paymaster.createSponsorPaymasterUserOperation(
        userOperation,
        bundlerUrl,
        sponsorshipPolicyId,
    )
    userOperation = sponsoredUserOp

    // -----------------------------------------------------------------------
    // Step 7: Sign with Passkey
    // -----------------------------------------------------------------------
    printSection('Phase B: Sign with Passkey')

    // Get the EIP-712 hash that needs to be signed
    const userOpHash = SafeAccount.getUserOperationEip712Hash(
        userOperation,
        BigInt(chainId),
    )

    console.log(`UserOp EIP-712 hash: ${userOpHash}`)

    // Simulate passkey authentication (biometric prompt in a real browser)
    const assertion = navigator.credentials.get({
        publicKey: {
            challenge: hexToBytes(userOpHash as `0x${string}`),
            rpId: 'safe.global',
            allowCredentials: [{
                type: 'public-key',
                id: new Uint8Array(credential.rawId),
            }],
            userVerification: UserVerificationRequirement.required,
        },
    })

    // Extract signature components and format for Safe verification
    const webauthnSignatureData: WebauthnSignatureData = {
        authenticatorData: assertion.response.authenticatorData,
        clientDataFields: extractClientDataFields(assertion.response),
        rs: extractSignature(assertion.response),
    }

    const webauthnSignature = SafeAccount.createWebAuthnSignature(webauthnSignatureData)

    const signerSignaturePair: SignerSignaturePair = {
        signer: webauthPublicKey,
        signature: webauthnSignature,
    }

    // Pack the signature into the UserOperation
    userOperation.signature = SafeAccount.formatSignaturesToUseroperationSignature(
        [signerSignaturePair],
        { isInit: userOperation.nonce == 0n }
    )

    console.log('Passkey signature applied')

    // -----------------------------------------------------------------------
    // Step 8: Submit and Confirm
    // -----------------------------------------------------------------------
    printSection('Phase B: Submit UserOp')

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
