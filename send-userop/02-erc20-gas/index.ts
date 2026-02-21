/**
 * Submit a UserOperation with ERC-20 Gas Payment (USDT)
 *
 * Gas fees are paid in USDT — no ETH required in the account.
 * Get test USDT at: https://dashboard.candide.dev/faucet
 *
 * Required env vars:
 *   CHAIN_ID, NODE_URL, BUNDLER_URL, PAYMASTER_URL, PAYMASTER_ADDRESS,
 *   PAYMASTER_TOKEN_ADDRESS, ENTRY_POINT_ADDRESS
 *
 * Run: npm run send-userop-erc20
 */

import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import { Bundler, SendUseroperationResponse } from 'abstractionkit'
import * as dotenv from 'dotenv'
import * as readline from 'readline'
import { generateMnemonic, english } from 'viem/accounts'

dotenv.config()

const chainId = Number(process.env.CHAIN_ID)
const nodeUrl = process.env.NODE_URL as string
const bundlerUrl = process.env.BUNDLER_URL as string
const paymasterUrl = process.env.PAYMASTER_URL as string
const paymasterAddress = process.env.PAYMASTER_ADDRESS as string
const paymasterTokenAddress = process.env.PAYMASTER_TOKEN_ADDRESS as string
const entryPointAddress = process.env.ENTRY_POINT_ADDRESS as string
const seedPhrase = process.env.SEED_PHRASE || generateMnemonic(english) as string

const wallet = new WalletManagerEvmErc4337(seedPhrase, {
    chainId,
    provider: nodeUrl,
    bundlerUrl,
    entryPointAddress,
    safeModulesVersion: '0.3.0',
    paymasterUrl,
    paymasterAddress,
    paymasterToken: { address: paymasterTokenAddress },
})

const account = await wallet.getAccount(0)
const accountAddress = await account.getAddress()

console.log(`Safe Account: ${accountAddress}`)

// Check USDT balance — the account needs tokens before sending
const balance = await account.getPaymasterTokenBalance()
console.log(`USDT balance: ${Number(balance) / 1e6} USDT`)

if (balance === 0n) {
    console.log(`\nFund this account with USDT to pay for gas:`)
    console.log(`  Faucet:  https://dashboard.candide.dev/faucet`)
    console.log(`  Address: ${accountAddress}\n`)

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    await new Promise<void>((resolve) => rl.question('Press Enter once funded...', () => { rl.close(); resolve() }))

    const balanceAfter = await account.getPaymasterTokenBalance()
    if (balanceAfter === 0n) {
        console.log('No USDT found. Exiting.')
        account.dispose()
        wallet.dispose()
        process.exit(1)
    }
    console.log(`Updated balance: ${Number(balanceAfter) / 1e6} USDT`)
}

// Send a no-op transaction — gas is deducted from the USDT balance
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
console.log(`USDT balance after: ${Number(await account.getPaymasterTokenBalance()) / 1e6} USDT`)

account.dispose()
wallet.dispose()
