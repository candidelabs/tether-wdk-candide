/**
 * Cancel a Pending Recovery
 *
 * This example shows how the original Safe owner can cancel a recovery request
 * during the grace period. This is the primary protection against malicious or
 * mistaken recovery attempts — the original owner still has time to react.
 *
 * This works identically regardless of guardian type (personal guardian or
 * Candide custodial guardian). The Safe account itself calls cancelRecovery()
 * on the Social Recovery Module — guardian type is irrelevant at this point.
 * WDK submits a UserOperation from the Safe to do exactly that.
 *
 * What it does:
 *   1. Reads the pending recovery request from on-chain
 *   2. Initializes the Safe account via WDK
 *   3. Cancels the recovery (Safe calls SRM.cancelRecovery())
 *   4. Waits for confirmation
 *   5. Verifies the recovery was cancelled
 *
 * Libraries used:
 *   - WDK: Account management and UserOperation submission
 *   - abstractionkit: SocialRecoveryModule for state queries and cancel tx
 *
 * Required env vars (see .env.example):
 *   - SEED_PHRASE: Owner's BIP-39 seed phrase
 *   - SAFE_ACCOUNT_ADDRESS: Address of the Safe to protect
 *   - CHAIN_ID: Chain ID (e.g., 11155111 for Sepolia)
 *   - NODE_URL: JSON-RPC provider URL
 *   - BUNDLER_URL: ERC-4337 bundler URL
 *   - PAYMASTER_URL: Candide paymaster URL
 *   - ENTRY_POINT_ADDRESS: Entry point contract address
 *
 * Optional env vars:
 *   - SPONSORSHIP_POLICY_ID: Gas sponsorship policy ID
 *
 * Run: npm run cancel-recovery
 */

import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import {
    Bundler,
    SendUseroperationResponse,
    SocialRecoveryModule,
    SocialRecoveryModuleGracePeriodSelector,
} from 'abstractionkit'
import * as dotenv from 'dotenv'

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Wait for a UserOperation to be included in a block
 */
async function waitForUserOperation(
    userOperationHash: string,
    bundlerUrl: string,
    entryPointAddress: string
) {
    const bundler = new Bundler(bundlerUrl)
    const response = new SendUseroperationResponse(userOperationHash, bundler, entryPointAddress)
    return response.included()
}

function printSection(title: string) {
    console.log('\n' + '═'.repeat(60))
    console.log(`  ${title}`)
    console.log('═'.repeat(60))
}

// ============================================================================
// Main Function
// ============================================================================

async function main() {
    dotenv.config()

    console.log('\n' + '═'.repeat(60))
    console.log('  Cancel Pending Recovery')
    console.log('═'.repeat(60))

    // ---------------------------------------------------------------------------
    // Step 1: Load Configuration
    // ---------------------------------------------------------------------------
    printSection('Configuration')

    const requiredEnvVars = [
        'SEED_PHRASE', 'SAFE_ACCOUNT_ADDRESS',
        'CHAIN_ID', 'NODE_URL', 'BUNDLER_URL', 'PAYMASTER_URL', 'ENTRY_POINT_ADDRESS',
    ]
    const missing = requiredEnvVars.filter(v => !process.env[v])
    if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(', ')}`)
    }

    const seedPhrase = process.env.SEED_PHRASE as string
    const safeAccountAddress = process.env.SAFE_ACCOUNT_ADDRESS as string
    const chainId = Number(process.env.CHAIN_ID)
    const nodeUrl = process.env.NODE_URL as string
    const bundlerUrl = process.env.BUNDLER_URL as string
    const paymasterUrl = process.env.PAYMASTER_URL as string
    const entryPointAddress = process.env.ENTRY_POINT_ADDRESS as string
    const sponsorshipPolicyId = process.env.SPONSORSHIP_POLICY_ID as string

    console.log(`Safe Account: ${safeAccountAddress}`)
    console.log(`Chain ID:     ${chainId}`)

    // ---------------------------------------------------------------------------
    // Step 2: Check Pending Recovery
    // ---------------------------------------------------------------------------
    printSection('Check Pending Recovery')

    // Must use the same grace period selector as the setup example (01).
    const srm = new SocialRecoveryModule(SocialRecoveryModuleGracePeriodSelector.After3Minutes)

    const recoveryRequest = await srm.getRecoveryRequest(nodeUrl, safeAccountAddress)

    if (recoveryRequest.executeAfter === 0n) {
        console.log('No pending recovery request found. Nothing to cancel.')
        return
    }

    const executeAfterDate = new Date(Number(recoveryRequest.executeAfter) * 1000)
    const now = new Date()
    const canFinalize = now >= executeAfterDate

    console.log(`Pending recovery found:`)
    console.log(`  New owners:    ${recoveryRequest.newOwners.join(', ')}`)
    console.log(`  New threshold: ${recoveryRequest.newThreshold}`)
    console.log(`  Finalizable:   ${executeAfterDate.toISOString()}`)
    if (canFinalize) {
        console.log(`  ⚠️  Grace period has elapsed — cancel immediately!`)
    } else {
        console.log(`  Grace period still active — cancellation window is open.`)
    }

    // ---------------------------------------------------------------------------
    // Step 3: Initialize Safe Account (Owner)
    // ---------------------------------------------------------------------------
    printSection('Initialize Safe Account')

    // The Safe account itself must send the cancellation, not the EOA owner.
    // WDK submits a UserOperation from the Safe, which calls cancelRecovery()
    // on the Social Recovery Module contract.
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

    if (accountAddress.toLowerCase() !== safeAccountAddress.toLowerCase()) {
        throw new Error(
            `Seed phrase derives ${accountAddress}, not ${safeAccountAddress}. ` +
            `Only the original Safe owner can cancel.`
        )
    }

    console.log(`✓ Owner confirmed: ${accountAddress}`)

    // ---------------------------------------------------------------------------
    // Step 4: Cancel Recovery
    // ---------------------------------------------------------------------------
    printSection('Cancel Recovery')

    // createCancelRecoveryMetaTransaction() takes no arguments. The Safe account
    // is always the caller, and the SRM uses msg.sender to identify which Safe
    // is cancelling its own recovery.
    const cancelTx = srm.createCancelRecoveryMetaTransaction()

    console.log('Submitting cancellation...')

    const result = await account.sendTransaction([cancelTx])
    console.log(`✓ Submitted: ${result.hash}`)

    // ---------------------------------------------------------------------------
    // Step 5: Wait for Confirmation
    // ---------------------------------------------------------------------------
    printSection('Wait for Confirmation')

    console.log('Waiting for on-chain confirmation...')

    const receipt = await waitForUserOperation(result.hash, bundlerUrl, entryPointAddress)

    if (!receipt.success) {
        throw new Error('Cancellation UserOperation failed on-chain')
    }

    console.log(`✓ Confirmed: ${receipt.receipt.transactionHash}`)

    // ---------------------------------------------------------------------------
    // Step 6: Verify Cancellation
    // ---------------------------------------------------------------------------
    printSection('Verify Cancellation')

    const afterCancel = await srm.getRecoveryRequest(nodeUrl, safeAccountAddress)

    if (afterCancel.executeAfter === 0n) {
        console.log('✓ Recovery successfully cancelled')
        console.log('  The Safe remains under your control.')
    } else {
        console.log('✗ Unexpected: recovery request still present after cancellation')
    }

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
