/**
 * Submit a UserOperation with Sponsored Gas
 *
 * The paymaster covers all gas fees — no ETH required in the account.
 * Gas policies are configured at dashboard.candide.dev.
 *
 * Required env vars:
 *   CHAIN_ID, NODE_URL, BUNDLER_URL, PAYMASTER_URL, ENTRY_POINT_ADDRESS,
 *   SPONSORSHIP_POLICY_ID
 *
 * Run: npm run send-userop-sponsored
 */

import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import { Bundler, SendUseroperationResponse } from 'abstractionkit'
import * as dotenv from 'dotenv'
import { generateMnemonic, english } from 'viem/accounts'

dotenv.config()

const chainId = Number(process.env.CHAIN_ID)
const nodeUrl = process.env.NODE_URL as string
const bundlerUrl = process.env.BUNDLER_URL as string
const paymasterUrl = process.env.PAYMASTER_URL as string
const entryPointAddress = process.env.ENTRY_POINT_ADDRESS as string
const sponsorshipPolicyId = process.env.SPONSORSHIP_POLICY_ID as string
const seedPhrase = process.env.SEED_PHRASE || generateMnemonic(english) as string

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

// Send a no-op transaction — replace with any contract call
const result = await account.sendTransaction({
    to: accountAddress,
    value: 0n,
    data: '0x',
})

console.log(`UserOp hash: ${result.hash}`)
console.log('Waiting for confirmation...')

const bundler = new Bundler(bundlerUrl)
const response = new SendUseroperationResponse(result.hash, bundler, entryPointAddress)
const receipt = await response.included()

if (!receipt.success) {
    throw new Error(`UserOperation reverted. Tx: ${receipt.receipt.transactionHash}`)
}

console.log(`Confirmed: ${receipt.receipt.transactionHash}`)

account.dispose()
wallet.dispose()
