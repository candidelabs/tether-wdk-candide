/**
 * Enable Email/SMS Account Recovery
 * 
 * This example demonstrates how to set up email/SMS-based account recovery
 * for a Safe smart account using WDK + abstractionkit + safe-recovery-service-sdk.
 * 
 * What it does:
 *   1. Create a Safe account from a BIP-39 seed phrase
 *   2. Deploy the Safe with Social Recovery Module enabled
 *   3. Register email and/or SMS channels with Candide Guardian Service
 *   4. Add the Candide Guardian on-chain (can sign recovery requests)
 * 
 * The Candide Guardian acts as a "custodial guardian" - when you lose access
 * to your account, you verify your identity via OTP (email/SMS) and the
 * guardian will sign a recovery request to transfer ownership to a new key.
 * 
 * Required env vars (see .env.example):
 *   - CHAIN_ID: Chain ID (e.g., 11155111 for Sepolia)
 *   - NODE_URL: JSON-RPC provider URL
 *   - BUNDLER_URL: ERC-4337 bundler URL  
 *   - PAYMASTER_URL: Candide paymaster URL
 *   - RECOVERY_SERVICE_URL: Candide Guardian Service URL
 * 
 * Optional env vars:
 *   - SEED_PHRASE: Your BIP-39 seed phrase (will generate if not provided)
 *   - SPONSORSHIP_POLICY_ID: Gas sponsorship policy ID
 *   - USER_EMAIL: Pre-fill email (will prompt if not set)
 * 
 * Run: npm run enable-email-sms-recovery
 */

import * as dotenv from 'dotenv'
import * as readline from 'readline'

import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import {
    Bundler,
    SendUseroperationResponse,
    SafeAccountV0_3_0 as SafeAccount,
    getSafeMessageEip712Data,
    SAFE_MESSAGE_PRIMARY_TYPE,
    SocialRecoveryModule,
    SocialRecoveryModuleGracePeriodSelector,
} from 'abstractionkit'
import { RecoveryByCustodialGuardian, SafeRecoveryServiceSdkError } from 'safe-recovery-service-sdk'
import { TypedDataDomain } from 'viem'
import { mnemonicToAccount, generateMnemonic, english } from 'viem/accounts'

// ============================================================================
// Configuration
// ============================================================================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

// ============================================================================
// Helper Functions
// ============================================================================

/** Prompt user for input */
async function askQuestion(question: string): Promise<string> {
    return new Promise((resolve) => rl.question(question, resolve))
}

/**
 * Wait for a UserOperation to be included in a block
 * Uses abstractionkit's SendUseroperationResponse.included() which polls
 * the bundler until the UserOperation is confirmed on-chain.
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

/**
 * Sign a SIWE message using EIP-1271 (Safe's signature scheme)
 * 
 * The Safe contract validates off-chain messages using its own signature scheme.
 * We wrap the message in Safe-specific EIP-712 format and use buildSignaturesFromSingerSignaturePairs
 * to format the signature correctly for the Safe contract.
 */
async function signSafeMessage(
    accountAddress: string,
    chainId: number,
    message: string,
    ownerAccount: ReturnType<typeof mnemonicToAccount>
): Promise<string> {
    const safeTypedData = getSafeMessageEip712Data(
        accountAddress,
        BigInt(chainId),
        message
    )

    const ownerSignature = await ownerAccount.signTypedData({
        domain: safeTypedData.domain as TypedDataDomain,
        types: safeTypedData.types,
        primaryType: SAFE_MESSAGE_PRIMARY_TYPE,
        message: safeTypedData.messageValue as Record<string, unknown>
    } as Parameters<typeof ownerAccount.signTypedData>[0])

    // Use SafeAccountV0_3_0.buildSignaturesFromSingerSignaturePairs to format
    // the signature in the format the Safe contract expects
    return SafeAccount.buildSignaturesFromSingerSignaturePairs([
        { signer: ownerAccount.address, signature: ownerSignature }
    ])
}

/**
 * Print a section header for better readability
 */
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
    console.log('  Email/SMS Account Recovery Setup')
    console.log('═'.repeat(60))

    // ---------------------------------------------------------------------------
    // Step 1: Load Configuration
    // ---------------------------------------------------------------------------
    printSection('Configuration')

    const requiredEnvVars = [
        'CHAIN_ID', 'RECOVERY_SERVICE_URL', 'BUNDLER_URL', 'NODE_URL',
        'PAYMASTER_URL', 'ENTRY_POINT_ADDRESS',
    ]
    const missing = requiredEnvVars.filter(v => !process.env[v])
    if (missing.length > 0) {
        throw new Error(`Missing required: ${missing.join(', ')}`)
    }

    const chainId = Number(process.env.CHAIN_ID)
    const serviceUrl = process.env.RECOVERY_SERVICE_URL as string
    const bundlerUrl = process.env.BUNDLER_URL as string
    const nodeUrl = process.env.NODE_URL as string
    const paymasterUrl = process.env.PAYMASTER_URL as string
    const sponsorshipPolicyId = process.env.SPONSORSHIP_POLICY_ID as string
    const entryPointAddress = process.env.ENTRY_POINT_ADDRESS as string
    const seedPhrase = process.env.SEED_PHRASE || generateMnemonic(english) as string
    const userEmailFromEnv = process.env.USER_EMAIL as string

    console.log(`Chain ID:          ${chainId}`)
    console.log(`Recovery Service: ${serviceUrl}`)

    // ---------------------------------------------------------------------------
    // Step 2: Initialize Safe Account
    // ---------------------------------------------------------------------------
    printSection('Initialize Safe Account')

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

    console.log(`Safe Account:     ${accountAddress}`)
    console.log(`Seed Phrase:     ${seedPhrase.split(' ').slice(0, 3).join(' ')}...`)

    // ---------------------------------------------------------------------------
    // Step 3: Deploy Safe with Social Recovery Module
    // ---------------------------------------------------------------------------
    printSection('Deploy Safe')

    // Using 3-minute grace period for testing (use After3Days/After7Days/After14Days for production)
    const srm = new SocialRecoveryModule(SocialRecoveryModuleGracePeriodSelector.After3Minutes)

    // Check if the module is already enabled. If the Safe is not yet deployed
    // (counterfactual), this returns false and we proceed with enablement.
    const safeAccount = new SafeAccount(accountAddress)
    const moduleAlreadyEnabled = await safeAccount.isModuleEnabled(nodeUrl, srm.moduleAddress)

    if (moduleAlreadyEnabled) {
        console.log('Social Recovery Module already enabled — skipping enablement')
    } else {
        const enableModuleTx = srm.createEnableModuleMetaTransaction(accountAddress)

        console.log('Enabling Social Recovery Module...')
        const deployResult = await account.sendTransaction([enableModuleTx])
        console.log(`✓ UserOperation submitted: ${deployResult.hash}`)

        console.log('Waiting for confirmation...')
        const receipt = await waitForUserOperation(deployResult.hash, bundlerUrl, entryPointAddress)

        if (!receipt.success) {
            console.log('✗ Failed to enable Social Recovery Module')
            rl.close()
            return
        }
        console.log(`✓ Confirmed: ${receipt.receipt.transactionHash}`)
    }

    // ---------------------------------------------------------------------------
    // Step 4: Choose Recovery Channels
    // ---------------------------------------------------------------------------
    printSection('Choose Recovery Channels')

    console.log('Select verification channels for account recovery:')
    console.log('  1. Email only')
    console.log('  2. SMS only')
    console.log('  3. Both email AND SMS (more secure)')

    const choice = parseInt(await askQuestion('Enter choice (1-3): '))
    
    if (choice < 1 || choice > 3) {
        console.log('Invalid choice')
        rl.close()
        return
    }

    const enableEmail = choice === 1 || choice === 3
    const enableSms = choice === 2 || choice === 3

    // Get email/phone from user if not provided in env
    let finalUserEmail = userEmailFromEnv
    if (enableEmail && !finalUserEmail) {
        finalUserEmail = await askQuestion('Enter your email address: ')
    }

    let finalUserPhone = ''
    if (enableSms) {
        finalUserPhone = await askQuestion('Enter your phone number (+1234567890): ')
    }

    // ---------------------------------------------------------------------------
    // Step 5: Register with Candide Guardian Service
    // ---------------------------------------------------------------------------
    printSection('Register with Guardian Service')

    const guardianService = new RecoveryByCustodialGuardian(serviceUrl, BigInt(chainId))
    
    // Create owner account for signing messages (EIP-1271)
    const ownerAccount = mnemonicToAccount(seedPhrase, { accountIndex: 0 })

    let candideGuardianAddress = ''

    // Register Email
    if (enableEmail) {
        console.log(`\nRegistering email: ${finalUserEmail}`)

        const siweMessage = guardianService.createRegistrationToEmailRecoverySiweStatementToSign(
            accountAddress,
            finalUserEmail
        )

        const signature = await signSafeMessage(accountAddress, chainId, siweMessage, ownerAccount)

        const challengeId = await guardianService.createRegistrationToEmailRecovery(
            accountAddress,
            finalUserEmail,
            siweMessage,
            signature
        )

        const otpCode = await askQuestion(`OTP sent to ${finalUserEmail} — enter code: `)
        
        const result = await guardianService.submitRegistrationChallenge(challengeId, otpCode)
        
        console.log(`✓ Email registered`)
        candideGuardianAddress = result.guardianAddress
    }

    // Register SMS
    if (enableSms) {
        console.log(`\nRegistering SMS: ${finalUserPhone}`)

        const siweMessage = guardianService.createRegistrationToSmsRecoverySiweStatementToSign(
            accountAddress,
            finalUserPhone
        )

        const signature = await signSafeMessage(accountAddress, chainId, siweMessage, ownerAccount)

        const challengeId = await guardianService.createRegistrationToSmsRecovery(
            accountAddress,
            finalUserPhone,
            siweMessage,
            signature
        )

        const otpCode = await askQuestion(`OTP sent to ${finalUserPhone} — enter code: `)
        
        const result = await guardianService.submitRegistrationChallenge(challengeId, otpCode)
        
        console.log(`✓ SMS registered`)

        // Guardian address is the same for email and SMS
        if (!enableEmail) {
            candideGuardianAddress = result.guardianAddress
        }
    }

    // ---------------------------------------------------------------------------
    // Step 6: Add Guardian On-Chain
    // ---------------------------------------------------------------------------
    printSection('Add Guardian On-Chain')

    if (!candideGuardianAddress) {
        console.log('✗ No guardian address obtained')
        rl.close()
        return
    }

    const addGuardianTx = srm.createAddGuardianWithThresholdMetaTransaction(
        candideGuardianAddress,
        1n // threshold: 1 guardian required
    )

    console.log(`Adding guardian: ${candideGuardianAddress}`)
    const addResult = await account.sendTransaction([addGuardianTx])
    console.log(`✓ UserOperation submitted: ${addResult.hash}`)

    console.log('Waiting for confirmation...')
    const guardianReceipt = await waitForUserOperation(addResult.hash, bundlerUrl, entryPointAddress)

    if (!guardianReceipt.success) {
        console.log('✗ Failed to add guardian')
        rl.close()
        return
    }
    console.log(`✓ Guardian added in: ${guardianReceipt.receipt.transactionHash}`)

    // ---------------------------------------------------------------------------
    // Step 7: Verify Registration
    // ---------------------------------------------------------------------------
    printSection('Verify Setup')

    const registrationsSiweMessage = guardianService.getRegistrationsSiweStatementToSign(accountAddress)
    const registrationsSignature = await signSafeMessage(accountAddress, chainId, registrationsSiweMessage, ownerAccount)

    const registrations = await guardianService.getRegistrations(
        accountAddress,
        registrationsSiweMessage,
        registrationsSignature
    )

    console.log(`\nRegistered recovery channels:`)
    registrations.forEach((reg: { channel: string; target: string }, i: number) => {
        console.log(`  ${i + 1}. ${reg.channel}: ${reg.target}`)
    })

    // ---------------------------------------------------------------------------
    // Done
    // ---------------------------------------------------------------------------
    console.log('\n' + '═'.repeat(60))
    console.log('  Setup Complete!')
    console.log('═'.repeat(60))
    console.log('\nAdd these to your .env to setup alerts or cancel a recovery:')
    console.log(`  SEED_PHRASE="${seedPhrase}"`)
    console.log(`  SAFE_ACCOUNT_ADDRESS=${accountAddress}`)
    console.log('\nNext steps:')
    console.log('  npm run setup-alerts')
    console.log('  npm run recovery-flow-email-sms\n')

    // Cleanup
    account.dispose()
    wallet.dispose()
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
        }
        rl.close()
        process.exit(1)
    })
