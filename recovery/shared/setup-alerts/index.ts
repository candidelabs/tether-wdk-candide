/**
 * Set Up Recovery Alerts
 *
 * This example demonstrates how to subscribe to email/SMS notifications for
 * recovery events on a Safe smart account. This is a gasless operation — it
 * uses SIWE (Sign-In With Ethereum) for off-chain authentication and requires
 * no on-chain transaction.
 *
 * What it does:
 *   1. Check for existing alert subscriptions (uses SIWE to authenticate)
 *   2. Subscribe to email and/or SMS alerts
 *   3. Verify subscriptions via OTP
 *   4. Confirm active subscriptions
 *
 * Prerequisites:
 *   - A deployed Safe with Social Recovery Module enabled. This works with
 *     both recovery paths — personal guardian and email/SMS custodial guardian.
 *
 * SIGNING NOTE — plain EOA vs EIP-1271:
 *   This example uses plain EOA signing (ownerAccount.signMessage) for all SIWE
 *   messages. The Alerts service authenticates the owner EOA directly, so a
 *   simple personal_sign is sufficient.
 *
 *   Example 01 uses EIP-1271 Safe contract signing instead — the registration
 *   service there requires proof that the Safe account (not just the EOA) is
 *   authorizing the action, so the message must go through the Safe's EIP-712
 *   signing scheme.
 *
 * Required env vars (see .env.example):
 *   - CHAIN_ID: Chain ID (e.g., 11155111 for Sepolia)
 *   - RECOVERY_SERVICE_URL: Candide Guardian Service URL
 *   - SEED_PHRASE: Owner seed phrase — must match the one used in example 01
 *
 * Optional env vars:
 *   - SAFE_ACCOUNT_ADDRESS: Safe to subscribe alerts for (prompted if not set)
 *   - USER_EMAIL: Pre-fill email (prompted if not set)
 *   - USER_PHONE: Pre-fill phone number (prompted if not set)
 *
 * Run: npm run setup-alerts
 */

import * as dotenv from 'dotenv'
import * as readline from 'readline'

import { Alerts, SafeRecoveryServiceSdkError } from 'safe-recovery-service-sdk'
import { mnemonicToAccount } from 'viem/accounts'

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
    console.log('  Recovery Alerts Setup')
    console.log('═'.repeat(60))

    // ---------------------------------------------------------------------------
    // Step 1: Load Configuration
    // ---------------------------------------------------------------------------
    printSection('Configuration')

    const requiredEnvVars = ['CHAIN_ID', 'RECOVERY_SERVICE_URL', 'SEED_PHRASE']
    const missing = requiredEnvVars.filter(v => !process.env[v])
    if (missing.length > 0) {
        throw new Error(`Missing required env vars: ${missing.join(', ')}`)
    }

    const chainId = Number(process.env.CHAIN_ID)
    const serviceUrl = process.env.RECOVERY_SERVICE_URL as string

    const safeAccountAddress = process.env.SAFE_ACCOUNT_ADDRESS
        ? process.env.SAFE_ACCOUNT_ADDRESS
        : (await askQuestion('Enter your Safe account address: ')).trim()

    // Must be the same seed phrase used in example 01 — it derives the owner
    // address that was used to set up the Safe and register recovery channels.
    const seedPhrase = process.env.SEED_PHRASE as string

    const userEmailFromEnv = process.env.USER_EMAIL as string
    const userPhoneFromEnv = process.env.USER_PHONE as string

    // Derive the owner EOA from the seed phrase
    const ownerAccount = mnemonicToAccount(seedPhrase, { accountIndex: 0 })

    console.log(`Chain ID:         ${chainId}`)
    console.log(`Recovery Service: ${serviceUrl}`)
    console.log(`Safe Account:     ${safeAccountAddress}`)
    console.log(`Owner:            ${ownerAccount.address}`)

    // ---------------------------------------------------------------------------
    // Step 2: Initialize Alerts Service
    // ---------------------------------------------------------------------------
    printSection('Initialize Alerts Service')

    const alertsService = new Alerts(serviceUrl, BigInt(chainId))
    console.log('✓ Alerts service initialized')

    // ---------------------------------------------------------------------------
    // Step 3: Check Existing Subscriptions
    // ---------------------------------------------------------------------------
    printSection('Check Existing Subscriptions')

    // SIWE (Sign-In With Ethereum) proves EOA ownership without an on-chain tx.
    // The Alerts service uses plain personal_sign — the signer is the owner EOA.
    const getSubsSiweMessage = alertsService.getSubscriptionsSiweStatementToSign(ownerAccount.address)
    const getSubsSignature = await ownerAccount.signMessage({ message: getSubsSiweMessage })

    const existingSubscriptions = await alertsService.getActiveSubscriptions(
        safeAccountAddress,
        ownerAccount.address,
        getSubsSiweMessage,
        getSubsSignature
    )

    if (existingSubscriptions.length > 0) {
        console.log(`\nExisting subscriptions (${existingSubscriptions.length}):`)
        existingSubscriptions.forEach((sub: { channel: string; target: string }, i: number) => {
            console.log(`  ${i + 1}. ${sub.channel}: ${sub.target}`)
        })
        console.log()
    } else {
        console.log('No existing subscriptions found')
    }

    // ---------------------------------------------------------------------------
    // Step 4: Choose Alert Channels
    // ---------------------------------------------------------------------------
    printSection('Choose Alert Channels')

    console.log('Select notification channels for recovery events:')
    console.log('  1. Email only')
    console.log('  2. SMS only')
    console.log('  3. Both email AND SMS')

    const choice = parseInt(await askQuestion('Enter choice (1-3): '))

    if (choice < 1 || choice > 3) {
        console.log('Invalid choice')
        rl.close()
        return
    }

    const enableEmail = choice === 1 || choice === 3
    const enableSms = choice === 2 || choice === 3

    let finalUserEmail = userEmailFromEnv
    if (enableEmail && !finalUserEmail) {
        finalUserEmail = await askQuestion('Enter your email address: ')
    }

    let finalUserPhone = userPhoneFromEnv
    if (enableSms && !finalUserPhone) {
        finalUserPhone = await askQuestion('Enter your phone number (+1234567890): ')
    }

    // ---------------------------------------------------------------------------
    // Step 5: Subscribe to Email Alerts
    // ---------------------------------------------------------------------------
    if (enableEmail) {
        printSection('Subscribe to Email Alerts')

        console.log(`Creating email alert subscription for: ${finalUserEmail}`)

        // NOTE: The Alerts SDK exposes dedicated methods for email subscriptions
        // (createEmailSubscriptionSiweStatementToSign / createEmailSubscription)
        // but only a generic method for SMS (createSubscriptionSiweStatementToSign
        // with channel='sms'). Both paths work the same way — the asymmetry is in
        // the SDK interface, not in the underlying service behaviour.
        const emailSiweMessage = alertsService.createEmailSubscriptionSiweStatementToSign(
            safeAccountAddress,
            ownerAccount.address,
            finalUserEmail
        )

        const emailSignature = await ownerAccount.signMessage({ message: emailSiweMessage })

        const emailSubscriptionId = await alertsService.createEmailSubscription(
            safeAccountAddress,
            ownerAccount.address,
            finalUserEmail,
            emailSiweMessage,
            emailSignature
        )

        const otpCode = await askQuestion(`OTP sent to ${finalUserEmail} — enter code: `)

        try {
            const result = await alertsService.activateSubscription(emailSubscriptionId, otpCode)
            if (result) {
                console.log(`✓ Email alerts activated`)
            } else {
                console.log(`✗ Failed to activate email alerts`)
            }
        } catch (error) {
            if (error instanceof SafeRecoveryServiceSdkError) {
                console.error(`Error:`, error.stringify())
            } else {
                console.error(`Error:`, error instanceof Error ? error.message : error)
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Step 6: Subscribe to SMS Alerts
    // ---------------------------------------------------------------------------
    if (enableSms) {
        printSection('Subscribe to SMS Alerts')

        console.log(`Creating SMS alert subscription for: ${finalUserPhone}`)

        const smsSiweMessage = alertsService.createSubscriptionSiweStatementToSign(
            safeAccountAddress,
            ownerAccount.address,
            'sms',
            finalUserPhone
        )

        const smsSignature = await ownerAccount.signMessage({ message: smsSiweMessage })

        const smsSubscriptionId = await alertsService.createSubscription(
            safeAccountAddress,
            ownerAccount.address,
            'sms',
            finalUserPhone,
            smsSiweMessage,
            smsSignature
        )

        const otpCode = await askQuestion(`OTP sent to ${finalUserPhone} — enter code: `)

        try {
            const result = await alertsService.activateSubscription(smsSubscriptionId, otpCode)
            if (result) {
                console.log(`✓ SMS alerts activated`)
            } else {
                console.log(`✗ Failed to activate SMS alerts`)
            }
        } catch (error) {
            if (error instanceof SafeRecoveryServiceSdkError) {
                console.error(`Error:`, error.stringify())
            } else {
                console.error(`Error:`, error instanceof Error ? error.message : error)
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Step 7: Verify Active Subscriptions
    // ---------------------------------------------------------------------------
    printSection('Verify Subscriptions')

    const verifySiweMessage = alertsService.getSubscriptionsSiweStatementToSign(ownerAccount.address)
    const verifySignature = await ownerAccount.signMessage({ message: verifySiweMessage })

    const activeSubscriptions = await alertsService.getActiveSubscriptions(
        safeAccountAddress,
        ownerAccount.address,
        verifySiweMessage,
        verifySignature
    )

    console.log(`\nActive subscriptions (${activeSubscriptions.length}):`)
    activeSubscriptions.forEach((sub: { channel: string; target: string }, i: number) => {
        console.log(`  ${i + 1}. ${sub.channel}: ${sub.target}`)
    })

    // ---------------------------------------------------------------------------
    // Done
    // ---------------------------------------------------------------------------
    console.log('\n' + '═'.repeat(60))
    console.log('  Done!')
    console.log('═'.repeat(60))
    console.log('\nYou will receive notifications when:')
    console.log('  - A recovery request is initiated')
    console.log('  - A recovery request is executed')
    console.log('  - A recovery request is finalized')
    console.log('\nNext steps:')
    console.log('  - Email/SMS recovery: npm run recovery-flow-email-sms')
    console.log('  - Personal guardian recovery: npm run recovery-flow-personal-guardian\n')

    rl.close()
}

// ============================================================================
// Run
// ============================================================================

main()
    .then(() => process.exit(0))
    .catch((error) => {
        if (error instanceof SafeRecoveryServiceSdkError) {
            console.error('\nAlerts Service Error:', error.stringify())
        } else {
            console.error('\nError:', error instanceof Error ? error.message : error)
        }
        rl.close()
        process.exit(1)
    })
