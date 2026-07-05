/**
 * Gasless SPL Transfer with USDT Gas Payment (Solana Mainnet)
 *
 * Network fees are paid in USDT: no SOL required in the account.
 * Candide's Solana Paymaster (a hosted Kora endpoint) co-signs as fee
 * payer and charges the fee in USDT inside the same transaction.
 *
 * Required env vars:
 *   SOLANA_NODE_URL, SOLANA_PAYMASTER_URL
 *
 * Run: npm run solana-transfer-usdt-gas
 */

import WalletManagerSolanaGasless from '@tetherto/wdk-wallet-solana-gasless'
import { KoraClient } from '@solana/kora'
import { createSolanaRpc, signature } from '@solana/kit'
import * as dotenv from 'dotenv'
import * as readline from 'readline'

dotenv.config()

const nodeUrl = process.env.SOLANA_NODE_URL as string
const paymasterUrl = process.env.SOLANA_PAYMASTER_URL as string
// Mainnet USDT, the only fee token the paymaster accepts for now
const usdtMint = process.env.SOLANA_PAYMASTER_TOKEN || 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

const seedPhrase = process.env.SEED_PHRASE || WalletManagerSolanaGasless.getRandomSeedPhrase()
if (!process.env.SEED_PHRASE) {
    console.log('Generated a new seed phrase. Save it to .env as SEED_PHRASE before funding:')
    console.log(`  ${seedPhrase}\n`)
}

// The paymaster reports its fee payer address; transactions must name it
const kora = new KoraClient({ rpcUrl: paymasterUrl })
const { signer_address: paymasterAddress } = await kora.getPayerSigner()

const wallet = new WalletManagerSolanaGasless(seedPhrase, {
    provider: nodeUrl,
    paymasterUrl,
    paymasterAddress,
    paymasterToken: { address: usdtMint },
    transferMaxFee: 1_000000n, // abort if the quoted fee exceeds 1 USDT
})

const account = await wallet.getAccount(0)
const accountAddress = await account.getAddress()

console.log(`Solana account: ${accountAddress}`)

// Check USDT balance — the account needs tokens before sending
const balance = await account.getPaymasterTokenBalance()
console.log(`USDT balance: ${Number(balance) / 1e6} USDT`)

if (balance === 0n) {
    console.log(`\nFund this account with USDT on Solana mainnet (0.5 USDT is plenty):`)
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

const recipient = process.env.SOLANA_RECIPIENT || accountAddress
const transferAmount = BigInt(process.env.SOLANA_TRANSFER_AMOUNT || 100000) // base units, default 0.1 USDT

console.log(`\nTransferring ${Number(transferAmount) / 1e6} USDT to ${recipient}`)

const quote = await account.quoteTransfer({ token: usdtMint, recipient, amount: transferAmount })
console.log(`Estimated network fee: ${Number(quote.fee) / 1e6} USDT`)

// Transfer USDT. The fee is deducted from the USDT balance, not SOL
const result = await account.transfer({ token: usdtMint, recipient, amount: transferAmount })

console.log(`Transaction signature: ${result.hash}`)
console.log('Waiting for confirmation...')

const rpc = createSolanaRpc(nodeUrl)
const deadline = Date.now() + 60_000
let confirmed = false
while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature(result.hash)]).send()
    const status = value[0]?.confirmationStatus
    if (status === 'confirmed' || status === 'finalized') { confirmed = true; break }
    await new Promise((r) => setTimeout(r, 2000))
}
if (!confirmed) {
    throw new Error(`Transaction ${result.hash} not confirmed before timeout`)
}

console.log(`Confirmed: https://solscan.io/tx/${result.hash}`)
console.log(`USDT balance after: ${Number(await account.getPaymasterTokenBalance()) / 1e6} USDT`)

account.dispose()
wallet.dispose()
