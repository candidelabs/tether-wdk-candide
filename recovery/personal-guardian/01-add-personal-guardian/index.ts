/**
 * Add Personal Guardians to a Safe Smart Account
 *
 * This example demonstrates how to enable the Social Recovery Module on a Safe
 * smart account and add two guardians in a single batched UserOperation.
 *
 * What it does:
 *   1. Creates a Safe smart account from a BIP-39 seed phrase
 *   2. Enables the Social Recovery Module (3-minute grace period for testing)
 *   3. Adds two guardians with threshold 2 (both must sign to initiate recovery)
 *   4. All three transactions are batched into one UserOperation
 *
 * Libraries used:
 *   - WDK: Account creation, signing, and UserOperation submission via ERC-4337
 *   - abstractionkit: SocialRecoveryModule for meta-transaction builders
 *   - viem: Generate guardian key pairs for demonstration
 *
 * Required env vars (see .env.example):
 *   - CHAIN_ID: Chain ID (e.g., 11155111 for Sepolia)
 *   - NODE_URL: JSON-RPC provider URL
 *   - BUNDLER_URL: ERC-4337 bundler URL
 *   - PAYMASTER_URL: Candide paymaster URL
 *   - ENTRY_POINT_ADDRESS: Entry point contract address
 *
 * Optional env vars:
 *   - SEED_PHRASE: BIP-39 seed phrase (generated if not provided)
 *   - SPONSORSHIP_POLICY_ID: Gas sponsorship policy ID
 *   - GUARDIAN_1_PRIVATE_KEY: First guardian key (generated if not provided)
 *   - GUARDIAN_2_PRIVATE_KEY: Second guardian key (generated if not provided)
 *
 * Run: npm run add-personal-guardian
 */

import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import {
    Bundler,
    SafeAccountV0_3_0 as SafeAccount,
    SendUseroperationResponse,
    SocialRecoveryModule,
    SocialRecoveryModuleGracePeriodSelector,
} from 'abstractionkit'
import * as dotenv from 'dotenv'
import { generateMnemonic, generatePrivateKey, english, privateKeyToAccount } from 'viem/accounts'

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Wait for a UserOperation to be included in a block.
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
    console.log('  Add Personal Guardians')
    console.log('═'.repeat(60))

    // ---------------------------------------------------------------------------
    // Step 1: Load Configuration
    // ---------------------------------------------------------------------------
    printSection('Configuration')

    const requiredEnvVars = [
        'CHAIN_ID', 'NODE_URL', 'BUNDLER_URL', 'PAYMASTER_URL', 'ENTRY_POINT_ADDRESS',
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

    // ---------------------------------------------------------------------------
    // Step 2: Initialize Safe Account
    // ---------------------------------------------------------------------------
    printSection('Initialize Safe Account')

    // WDK derives a Safe smart account address from the seed phrase using BIP-44.
    // The Safe is not deployed until the first UserOperation is sent (counterfactual).
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

    // ---------------------------------------------------------------------------
    // Step 3: Set Up Guardian Keys
    // ---------------------------------------------------------------------------
    printSection('Guardian Keys')

    // In production, GUARDIAN_1/2_PRIVATE_KEY would be your trusted contacts'
    // wallet private keys. For demo, we generate them if not provided.
    // Save the printed values — you will need them to run the recovery flow.
    let guardian1PrivateKey = process.env.GUARDIAN_1_PRIVATE_KEY as `0x${string}`
    let guardian2PrivateKey = process.env.GUARDIAN_2_PRIVATE_KEY as `0x${string}`

    if (!guardian1PrivateKey) {
        guardian1PrivateKey = generatePrivateKey()
        console.log(`Generated GUARDIAN_1_PRIVATE_KEY=${guardian1PrivateKey}`)
    }
    if (!guardian2PrivateKey) {
        guardian2PrivateKey = generatePrivateKey()
        console.log(`Generated GUARDIAN_2_PRIVATE_KEY=${guardian2PrivateKey}`)
    }

    const guardian1Address = privateKeyToAccount(guardian1PrivateKey).address
    const guardian2Address = privateKeyToAccount(guardian2PrivateKey).address

    console.log(`Guardian 1: ${guardian1Address}`)
    console.log(`Guardian 2: ${guardian2Address}`)
    console.log(`Threshold:  2 (both guardians must sign to initiate recovery)`)

    // ---------------------------------------------------------------------------
    // Step 4: Build Social Recovery Transactions
    // ---------------------------------------------------------------------------
    printSection('Build Transactions')

    // Using the 3-minute grace period contract for testing.
    // For production use After3Days / After7Days / After14Days.
    // IMPORTANT: the recovery flow example must use the same grace period selector —
    // each selector maps to a different SRM contract address.
    const srm = new SocialRecoveryModule(SocialRecoveryModuleGracePeriodSelector.After3Minutes)

    // Check if the module is already enabled. If the Safe is not yet deployed
    // (counterfactual), this returns false and we proceed with enablement.
    const safeAccount = new SafeAccount(accountAddress)
    const moduleAlreadyEnabled = await safeAccount.isModuleEnabled(nodeUrl, srm.moduleAddress)

    const transactions = []

    if (moduleAlreadyEnabled) {
        console.log(`Social Recovery Module already enabled — skipping enablement`)
    } else {
        const enableModuleTx = srm.createEnableModuleMetaTransaction(accountAddress)
        transactions.push(enableModuleTx)
        console.log(`1. Enable Social Recovery Module`)
    }

    // Add guardian 1 with threshold 1 (temporary while adding both)
    const addGuardian1Tx = srm.createAddGuardianWithThresholdMetaTransaction(
        guardian1Address,
        1n // Threshold set to 1 temporarily — guardian 2 will raise it to 2
    )
    transactions.push(addGuardian1Tx)
    console.log(`${transactions.length}. Add Guardian 1: ${guardian1Address}`)

    // Add guardian 2 and raise threshold to 2.
    // Both guardians must sign any future recovery request.
    const addGuardian2Tx = srm.createAddGuardianWithThresholdMetaTransaction(
        guardian2Address,
        2n
    )
    transactions.push(addGuardian2Tx)
    console.log(`${transactions.length}. Add Guardian 2: ${guardian2Address} (threshold → 2)`)

    // ---------------------------------------------------------------------------
    // Step 5: Submit Batched UserOperation
    // ---------------------------------------------------------------------------
    printSection('Submit UserOperation')

    // WDK batches all transactions into a single UserOperation.
    console.log('Submitting batched UserOperation...')

    const result = await account.sendTransaction(transactions)
    console.log(`✓ Submitted: ${result.hash}`)

    // ---------------------------------------------------------------------------
    // Step 6: Wait for Confirmation
    // ---------------------------------------------------------------------------
    printSection('Wait for Confirmation')

    console.log('Waiting for on-chain confirmation...')

    const receipt = await waitForUserOperation(result.hash, bundlerUrl, entryPointAddress)

    if (!receipt.success) {
        throw new Error('UserOperation failed on-chain')
    }

    console.log(`✓ Confirmed: ${receipt.receipt.transactionHash}`)

    // ---------------------------------------------------------------------------
    // Step 7: Verify Guardians Were Added
    // ---------------------------------------------------------------------------
    printSection('Verify Setup')

    const [isGuardian1, isGuardian2, onChainThreshold] = await Promise.all([
        srm.isGuardian(nodeUrl, accountAddress, guardian1Address),
        srm.isGuardian(nodeUrl, accountAddress, guardian2Address),
        srm.threshold(nodeUrl, accountAddress),
    ])

    console.log(`Guardian 1: ${isGuardian1 ? '✓ added' : '✗ not found'}`)
    console.log(`Guardian 2: ${isGuardian2 ? '✓ added' : '✗ not found'}`)
    console.log(`Threshold:  ${onChainThreshold}`)

    // ---------------------------------------------------------------------------
    // Done — print values needed for the next example
    // ---------------------------------------------------------------------------
    console.log('\n' + '═'.repeat(60))
    console.log('  Done!')
    console.log('═'.repeat(60))
    console.log('\nAdd these to your .env for the follow-up examples:')
    console.log(`  SEED_PHRASE="${seedPhrase}"`)
    console.log(`  SAFE_ACCOUNT_ADDRESS=${accountAddress}`)
    console.log(`  GUARDIAN_1_PRIVATE_KEY=${guardian1PrivateKey}`)
    console.log(`  GUARDIAN_2_PRIVATE_KEY=${guardian2PrivateKey}`)
    console.log('\nNext steps:')
    console.log('  npm run setup-alerts')
    console.log('  npm run recovery-flow-personal-guardian\n')
    console.log()

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
