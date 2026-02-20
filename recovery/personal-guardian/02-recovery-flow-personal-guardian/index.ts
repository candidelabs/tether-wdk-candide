/**
 * Recovery Flow (Personal Guardian)
 *
 * This example demonstrates how to recover a Safe smart account using personal
 * guardians (EOA wallets). Run example 01 (add-personal-guardian) first to set
 * up the guardians and obtain the values needed here.
 *
 * What it does:
 *   1. Guardian 1 creates a recovery request (signs EIP-712 data)
 *   2. Guardian 2 adds their signature
 *   3. Recovery is executed on-chain (grace period starts)
 *   4. Wait for the 3-minute grace period
 *   5. Finalize the recovery
 *   6. Verify the new owner on-chain
 *
 * Recovery status progression: PENDING → EXECUTED → FINALIZED
 *
 * Libraries used:
 *   - abstractionkit: SocialRecoveryModule for EIP-712 data, SafeAccountV0_3_0 for queries
 *   - safe-recovery-service-sdk: RecoveryByGuardian for off-chain coordination
 *   - viem: Sign typed data
 *
 * Required env vars (see .env.example):
 *   - CHAIN_ID: Chain ID (e.g., 11155111 for Sepolia)
 *   - NODE_URL: JSON-RPC provider URL
 *   - RECOVERY_SERVICE_URL: Candide Recovery Service URL
 *   - GUARDIAN_1_PRIVATE_KEY: Private key of first guardian
 *   - GUARDIAN_2_PRIVATE_KEY: Private key of second guardian
 *
 * Optional env vars:
 *   - SAFE_ACCOUNT_ADDRESS: Safe to recover (prompted if not set)
 *   - NEW_OWNER_ADDRESS: Address to recover ownership to (generated if not set)
 *
 * Run: npm run recovery-flow-personal-guardian
 */

import {
    EXECUTE_RECOVERY_PRIMARY_TYPE,
    SafeAccountV0_3_0 as SafeAccount,
    SocialRecoveryModule,
    SocialRecoveryModuleGracePeriodSelector,
} from 'abstractionkit'
import * as dotenv from 'dotenv'
import * as readline from 'readline'
import { RecoveryByGuardian, SafeRecoveryServiceSdkError } from 'safe-recovery-service-sdk'
import { TypedDataDomain } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// ============================================================================
// Configuration
// ============================================================================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

// ============================================================================
// Helper Functions
// ============================================================================

async function askQuestion(question: string): Promise<string> {
    return new Promise((resolve) => rl.question(question, resolve))
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
    console.log('  Recovery Flow (Personal Guardian)')
    console.log('═'.repeat(60))

    // ---------------------------------------------------------------------------
    // Step 1: Load Configuration
    // ---------------------------------------------------------------------------
    printSection('Configuration')

    const requiredEnvVars = [
        'CHAIN_ID',
        'NODE_URL',
        'RECOVERY_SERVICE_URL',
        'GUARDIAN_1_PRIVATE_KEY',
        'GUARDIAN_2_PRIVATE_KEY',
    ]
    const missing = requiredEnvVars.filter(v => !process.env[v])
    if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(', ')}`)
    }

    const chainId = BigInt(process.env.CHAIN_ID as string)
    const nodeUrl = process.env.NODE_URL as string
    const serviceUrl = process.env.RECOVERY_SERVICE_URL as string

    const guardian1PrivateKey = process.env.GUARDIAN_1_PRIVATE_KEY as `0x${string}`
    const guardian2PrivateKey = process.env.GUARDIAN_2_PRIVATE_KEY as `0x${string}`

    const guardian1Account = privateKeyToAccount(guardian1PrivateKey)
    const guardian2Account = privateKeyToAccount(guardian2PrivateKey)

    // Safe address: read from env or prompt
    const safeAccountAddress = process.env.SAFE_ACCOUNT_ADDRESS
        ? process.env.SAFE_ACCOUNT_ADDRESS
        : (await askQuestion('Enter Safe account address: ')).trim()

    // New owner: read from env or generate a demo key.
    // IMPORTANT: if generated, the private key is printed below — save it before
    // continuing, or you will recover into an account you cannot access.
    let newOwnerAddress: `0x${string}`
    if (process.env.NEW_OWNER_ADDRESS) {
        newOwnerAddress = process.env.NEW_OWNER_ADDRESS as `0x${string}`
        console.log(`\nNew owner (from env): ${newOwnerAddress}`)
    } else {
        const newOwnerPrivateKey = generatePrivateKey()
        newOwnerAddress = privateKeyToAccount(newOwnerPrivateKey).address as `0x${string}`
        console.log(`\n⚠️  NEW OWNER KEY GENERATED — SAVE THIS BEFORE CONTINUING`)
        console.log(`   Private key: ${newOwnerPrivateKey}`)
        console.log(`   Address:     ${newOwnerAddress}`)
        console.log(`   Add to .env: NEW_OWNER_ADDRESS=${newOwnerAddress}`)
    }

    console.log(`\nSafe Account: ${safeAccountAddress}`)
    console.log(`Guardian 1:   ${guardian1Account.address}`)
    console.log(`Guardian 2:   ${guardian2Account.address}`)
    console.log(`New owner:    ${newOwnerAddress}`)

    // ---------------------------------------------------------------------------
    // Step 2: Initialize Services
    // ---------------------------------------------------------------------------
    printSection('Initialize Services')

    // Must use the same grace period selector as the setup example (01).
    // Each selector maps to a different SRM contract address on-chain.
    const srm = new SocialRecoveryModule(SocialRecoveryModuleGracePeriodSelector.After3Minutes)

    const recoveryService = new RecoveryByGuardian(
        serviceUrl,
        chainId,
        SocialRecoveryModuleGracePeriodSelector.After3Minutes
    )

    console.log('✓ Services initialized')

    // ---------------------------------------------------------------------------
    // Step 3: Create Recovery Request (Guardian 1 signs)
    // ---------------------------------------------------------------------------
    printSection('Create Recovery Request')

    // The recovery request specifies the new owner(s) and the new Safe threshold.
    // Here we recover to a single new owner with threshold 1.
    // newThreshold (1) is the Safe signing threshold after recovery — separate from
    // the guardian threshold (2) that determines how many guardians must sign.
    const recoveryRequestEip712Data = await srm.getRecoveryRequestEip712Data(
        nodeUrl,
        chainId,
        safeAccountAddress,
        [newOwnerAddress],
        1n // new Safe threshold after recovery
    )

    console.log(`EIP-712 domain: ${JSON.stringify(recoveryRequestEip712Data.domain)}`)

    const guardian1Signature = await guardian1Account.signTypedData({
        primaryType: EXECUTE_RECOVERY_PRIMARY_TYPE,
        domain: recoveryRequestEip712Data.domain as TypedDataDomain,
        types: recoveryRequestEip712Data.types,
        message: recoveryRequestEip712Data.messageValue as Record<string, unknown>,
    })

    console.log(`Guardian 1 signed recovery request`)

    const recoveryRequest = await recoveryService.createRecoveryRequest(
        safeAccountAddress,
        [newOwnerAddress],
        1, // new Safe threshold after recovery
        guardian1Account.address,
        guardian1Signature
    )

    console.log(`Recovery request created. ID: ${recoveryRequest.id}`)
    console.log(`Emoji (verify with account owner): ${recoveryRequest.emoji}`)

    // ---------------------------------------------------------------------------
    // Step 4: Guardian 2 Signs
    // ---------------------------------------------------------------------------
    printSection('Guardian 2 Signature')

    // Guardian 2 signs the same EIP-712 data to meet the threshold-2 requirement.
    const guardian2Signature = await guardian2Account.signTypedData({
        primaryType: EXECUTE_RECOVERY_PRIMARY_TYPE,
        domain: recoveryRequestEip712Data.domain as TypedDataDomain,
        types: recoveryRequestEip712Data.types,
        message: recoveryRequestEip712Data.messageValue as Record<string, unknown>,
    })

    await recoveryService.submitGuardianSignatureForRecoveryRequest(
        recoveryRequest.id,
        guardian2Account.address,
        guardian2Signature
    )

    console.log('Guardian 2 signature submitted')

    // ---------------------------------------------------------------------------
    // Step 5: Execute Recovery
    // ---------------------------------------------------------------------------
    printSection('Execute Recovery')

    console.log('Executing recovery request...')

    await recoveryService.executeRecoveryRequest(recoveryRequest.id)

    // Wait for the bundler to include the transaction
    await new Promise((resolve) => setTimeout(resolve, 30 * 1000))

    const executedRequest = await recoveryService.getExecutedRecoveryRequestForLatestNonce(
        nodeUrl,
        safeAccountAddress
    )

    if (executedRequest && executedRequest.status === 'EXECUTED') {
        console.log(`Recovery executed. Status: ${executedRequest.status}`)
        console.log(`Transaction hash: ${executedRequest.executeData.transactionHash}`)
    } else {
        console.log('Recovery execution may still be processing...')
    }

    // ---------------------------------------------------------------------------
    // Step 6: Wait for Grace Period
    // ---------------------------------------------------------------------------
    printSection('Grace Period')

    console.log(
        'Waiting 3-minute grace period (the original owner can cancel during this window)...'
    )
    await new Promise((resolve) => setTimeout(resolve, 4 * 60 * 1000))

    // ---------------------------------------------------------------------------
    // Step 7: Finalize Recovery
    // ---------------------------------------------------------------------------
    printSection('Finalize Recovery')

    const finalizationResult = await recoveryService.finalizeRecoveryRequest(
        recoveryRequest.id
    )

    if (!finalizationResult) {
        console.log('Recovery finalization failed')
        rl.close()
        return
    }

    console.log('Recovery finalized successfully')

    // Wait for the finalization transaction to land
    await new Promise((resolve) => setTimeout(resolve, 30 * 1000))

    // ---------------------------------------------------------------------------
    // Step 8: Verify New Owner On-Chain
    // ---------------------------------------------------------------------------
    printSection('Verify')

    const smartAccount = new SafeAccount(safeAccountAddress)
    const newOwners = await smartAccount.getOwners(nodeUrl)

    console.log('\nRecovery complete!')
    console.log(`Safe Account: ${safeAccountAddress}`)
    console.log(`New owners:   ${newOwners.join(', ')}`)

    rl.close()
}

// ============================================================================
// Run
// ============================================================================

main()
    .then(() => process.exit(0))
    .catch((error) => {
        if (error instanceof SafeRecoveryServiceSdkError) {
            console.error('\nRecovery Service Error:', error.stringify())
        } else {
            console.error('\nError:', error instanceof Error ? error.message : error)
            let cause = error?.cause
            while (cause) {
                console.error(
                    'Caused by:',
                    cause instanceof Error ? cause.message : JSON.stringify(cause)
                )
                cause = cause?.cause
            }
        }
        rl.close()
        process.exit(1)
    })
