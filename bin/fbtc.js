#!/usr/bin/env node

let argv = process.argv.slice(2)

let os = require('os')
let fs = require('fs')
let { join } = require('path')
let { randomBytes } = require('crypto')
let secp256k1 = require('secp256k1')
let coins = require('coins')
let connect = require('lotion-connect')
let ora = require('ora')
let bitcoin = require('../lib/bitcoin.js')
let base58 = require('bs58check')

const TESTNET_GCI =
  'fb880e70a53ca462c791b0ecef8b17bd0e091a52f42747319bb35b9cc8dc9a71'

const USAGE = `
Usage: fbtc [command]

  Commands:
    
    balance                       Display your fbtc address and balance
    send      [address] [amount]  Send deposited coins to another address
    deposit                       Generate and display Bitcoin deposit address
    withdraw  [address] [amount]  Withdraw fbtc to a Bitcoin address`

async function main() {
  if (argv.length === 0) {
    console.log(USAGE)
    process.exit()
  }

  let gci = process.env.gci || TESTNET_GCI
  let client = await connect(gci)
  let coinsWallet = loadWallet(client)

  let cmd = argv[0]
  if (cmd === 'balance' && argv.length === 1) {
    console.log(`
Your address: ${coinsWallet.address()}
Your balance: ${await coinsWallet.balance()}`)
    process.exit()
  } else if (cmd === 'send' && argv.length === 3) {
    let recipientCoinsAddress = argv[1]
    let amount = Number(argv[2])
    try {
      let result = await coinsWallet.send(recipientCoinsAddress, amount)
      if (result.check_tx.code) {
        throw new Error(result.check_tx.log)
      }
      if (result.deliver_tx.code) {
        throw new Error(result.deliver_tx.log)
      }
      process.exit()
    } catch (e) {
      console.log(e.message)
      process.exit(1)
    }
  } else if (cmd === 'deposit' && argv.length === 1) {
    let depositPrivateKey = generateSecpPrivateKey()
    let btcDepositAddress = bitcoin.deriveBtcAddress(depositPrivateKey)

    console.log(`Deposit address: ${btcDepositAddress}\n`)
    // change it to a check mark
    await doDepositProcess(
      depositPrivateKey,
      btcDepositAddress,
      client,
      coinsWallet
    )
    process.exit()
  } else if (cmd === 'withdraw' && argv.length === 3) {
    let recipientBtcAddress = argv[1]
    let amount = Number(argv[2])

    await doWithdrawProcess(coinsWallet, recipientBtcAddress, amount)

    process.exit()
  } else {
    console.log(USAGE)
    process.exit()
  }
}

main()

async function doDepositProcess(
  depositPrivateKey,
  intermediateBtcAddress,
  client,
  coinsWallet
) {
  let spinner = ora(`Waiting for deposit...`).start()
  // get validators and signatory keys
  let { validators, signatories } = await getPeggingInfo(client)
  // wait for a deposit to the intermediate btc address
  let depositUTXOs = await bitcoin.fetchUTXOs(intermediateBtcAddress)
  let depositAmount = depositUTXOs[0].value / 1e8
  spinner.succeed(`Detected incoming deposit of ${depositAmount} Bitcoin.`)
  let spinner2 = ora('Broadcasting deposit transaction...').start()

  // build intermediate address -> signatories transaction
  let depositTransaction = bitcoin.createDepositTx(
    depositPrivateKey,
    validators,
    signatories,
    base58.decode(coinsWallet.address()),
    depositUTXOs
  )
  await bitcoin.broadcastTx(depositTransaction)
  let explorerLink = `https://live.blockcypher.com/btc-testnet/tx/${bitcoin
    .getTxHash(depositTransaction)
    .reverse()
    .toString('hex')}`
  spinner2.succeed(`Deposit transaction relayed. ${explorerLink}`)

  let spinner3 = ora(
    'Waiting for Bitcoin miners to mine a block (this might take a while)...'
  ).start()
  await bitcoin.waitForConfirmation()
  spinner3.succeed(`Deposit succeeded.`)

  console.log('\n\nCheck your balance with:')
  console.log('$ pbtc balance')
}

async function doWithdrawProcess(coinsWallet, address, amount) {
  let spinner = ora('Broadcasting withdrawal transaction...').start()
  let res = await coinsWallet.send({
    type: 'bitcoin',
    amount,
    script: bitcoin.createOutputScript(address)
  })

  console.log(res)
  spinner.succeed('Broadcasted withdrawal transaction.')

  let spinner2 = ora(
    'Waiting for signatories to build Bitcoin transaction...'
  ).start()

  let utxos = await bitcoin.fetchUTXOs(address)
  let withdrawalTxLink = `https://live.blockcypher.com/btc-testnet/tx/${utxos[0].txid
    .reverse()
    .toString('hex')}`

  spinner2.succeed(`Withdrawal succeeded. ${withdrawalTxLink}`)
  return res
}

async function getPeggingInfo(client) {
  let validators = {}
  client.validators.forEach(v => {
    validators[v.pub_key.value] = v.voting_power
  })

  let signatories = await client.state.bitcoin.signatoryKeys

  return { signatories, validators }
}

function generateSecpPrivateKey() {
  let privKey = randomBytes(32)
  while (!secp256k1.privateKeyVerify(privKey)) {
    privKey = randomBytes(32)
  }
  return privKey
}

function loadWallet(client) {
  let privKey
  let path = join(os.homedir(), '.coins')
  if (!fs.existsSync(path)) {
    privKey = generateSecpPrivateKey()
  } else {
    privKey = Buffer.from(fs.readFileSync(path, 'utf8'), 'hex')
  }

  return coins.wallet(privKey, client, { route: 'pbtc' })
}
