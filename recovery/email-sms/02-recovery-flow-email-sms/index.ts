/**
 * Recovery Flow (Candide Guardian)
 *
 * This example demonstrates how to recover a Safe smart account using the
 * Candide Guardian Service. Run example 01 (enable-email-sms-recovery) first
 * to deploy the Safe and register email/SMS channels.
 *
 * What it does:
 *   1. Request a signature challenge from the Candide Guardian Service
 *   2. Verify identity via OTP on all registered channels (email and/or SMS)
 *   3. Create and execute the recovery request on-chain
 *   4. Wait for the 3-minute grace period
 *   5. Finalize the recovery
 *   6. Verify the new owner on-chain
 *
 * Recovery status progression: PENDING → EXECUTED → FINALIZED
 *
 * Libraries used:
 *   - abstractionkit: SafeAccountV0_3_0 for on-chain queries
 *   - safe-recovery-service-sdk: RecoveryByCustodialGuardian and RecoveryByGuardian
 *
 * Required env vars (see .env.example):
 *   - CHAIN_ID: Chain ID (e.g., 11155111 for Sepolia)
 *   - RECOVERY_SERVICE_URL: Candide Guardian Service URL
 *   - NODE_URL: JSON-RPC provider URL
 *
 * Optional env vars:
 *   - SAFE_ACCOUNT_ADDRESS: Safe to recover (prompted if not set)
 *   - NEW_OWNER_ADDRESS: Address to recover ownership to (generated if not set)
 *
 * Run: npm run recovery-flow-email-sms
 */

import {
    SafeAccountV0_3_0 as SafeAccount,
    SocialRecoveryModuleGracePeriodSelector,
} from 'abstractionkit'
import * as dotenv from 'dotenv'
import * as readline from 'readline'
import {
    RecoveryByCustodialGuardian,
    RecoveryByGuardian,
    SafeRecoveryServiceSdkError,
} from 'safe-recovery-service-sdk'
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
    console.log('  Recovery Flow (Candide Guardian)')
    console.log('═'.repeat(60))

    // ---------------------------------------------------------------------------
    // Step 1: Load Configuration
    // ---------------------------------------------------------------------------
    printSection('Configuration')

    const requiredEnvVars = ['CHAIN_ID', 'RECOVERY_SERVICE_URL', 'NODE_URL']
    const missing = requiredEnvVars.filter(v => !process.env[v])
    if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(', ')}`)
    }

    const chainId = BigInt(process.env.CHAIN_ID as string)
    const serviceUrl = process.env.RECOVERY_SERVICE_URL as string
    const nodeUrl = process.env.NODE_URL as string

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

    console.log(`\nSafe Account:      ${safeAccountAddress}`)
    console.log(`New owner (target): ${newOwnerAddress}`)
    console.log(`Recovery Service:  ${serviceUrl}`)

    // ---------------------------------------------------------------------------
    // Step 2: Initialize Services
    // ---------------------------------------------------------------------------
    printSection('Initialize Services')

    const custodialGuardianService = new RecoveryByCustodialGuardian(serviceUrl, chainId)

    // RecoveryByGuardian is used for finalization. Initialize it up front with
    // the same grace period selector as the setup example (01).
    const recoveryService = new RecoveryByGuardian(
        serviceUrl,
        chainId,
        SocialRecoveryModuleGracePeriodSelector.After3Minutes
    )

    console.log('✓ Services initialized')

    // ---------------------------------------------------------------------------
    // Step 3: Request Signature Challenge
    // ---------------------------------------------------------------------------
    printSection('Request Signature Challenge')

    const signatureRequest =
        await custodialGuardianService.requestCustodialGuardianSignatureChallenge(
            safeAccountAddress,
            [newOwnerAddress],
            1 // new Safe threshold after recovery
        )

    console.log('Registered channels to verify:')
    signatureRequest.auths.forEach((auth, i) => {
        console.log(`  ${i + 1}. ${auth.channel} — ${auth.target}`)
    })
    console.log('\nAll channels must be verified to proceed.')

    // ---------------------------------------------------------------------------
    // Step 4: Verify Identity via OTP
    // ---------------------------------------------------------------------------
    printSection('Verify Identity')

    let verificationResult

    for (const auth of signatureRequest.auths) {
        const otpCode = await askQuestion(`\nOTP sent to ${auth.target} — enter code: `)

        verificationResult =
            await custodialGuardianService.submitCustodialGuardianSignatureChallenge(
                signatureRequest.requestId,
                auth.challengeId,
                otpCode
            )

        if (verificationResult.success) {
            console.log(`✓ ${auth.channel} verified`)
        } else {
            console.log(`✗ ${auth.channel} verification failed`)
            rl.close()
            return
        }
    }

    if (
        !verificationResult ||
        !verificationResult.custodianGuardianAddress ||
        !verificationResult.custodianGuardianSignature
    ) {
        console.log('Error: Failed to obtain guardian signature after verification')
        rl.close()
        return
    }

    // ---------------------------------------------------------------------------
    // Step 5: Execute Recovery
    // ---------------------------------------------------------------------------
    printSection('Execute Recovery')

    console.log('Creating and executing recovery request...')

    const recoveryRequest =
        await custodialGuardianService.createAndExecuteRecoveryRequest(
            safeAccountAddress,
            [newOwnerAddress],
            1, // new Safe threshold after recovery
            verificationResult.custodianGuardianAddress as string,
            verificationResult.custodianGuardianSignature as string
        )

    console.log(`Recovery executed. Status: ${recoveryRequest.status}`)

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
            console.error('\nGuardian Service Error:', error.stringify())
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
