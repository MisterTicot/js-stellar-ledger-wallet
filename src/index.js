"use strict"
/**
 * A convenient wrapper around official Ledger Wallet libraries.
 *
 * **Usage:**
 *
 * async ledgerWallet.connect([accountNumber], [accountIndex], [internalFlag])
 * ledgerWallet.disconnect()
 *
 * // Events
 * ledgerWallet.onConnect => function ()
 * ledgerWallet.onDisconnect => function ()
 *
 * // After connection succeed
 * async ledgerWallet.sign(transaction)
 * ledgerWallet.publicKey
 * ledgerWallet.version
 * ledgerWallet.multiOpsEnabled
 * ledgerWallet.account
 * ledgerWallet.path
 * ledgerWallet.application
 * ledgerWallet.transport
 *
 * // After connection fail
 * ledgerWallet.error
 *
 * @exports ledger
 */
const ledger = exports

const env = require("@cosmic-plus/jsutils/es5/env")
const misc = require("@cosmic-plus/jsutils/es5/misc")

if (env.isNode) {
  global.regeneratorRuntime = env.nodeRequire("regenerator-runtime")
}

const StellarApp = require("@ledgerhq/hw-app-str").default
const Transport = env.isBrowser
  ? require("@ledgerhq/hw-transport-u2f").default
  : env.nodeRequire("@ledgerhq/hw-transport-node-hid").default

/**
 * Methods
 */

let connection, disconnection

/**
 * Connect
 */

ledger.connect = async function (account, index, internalFlag) {
  if (account === undefined) {
    account = ledger.account || 0
    index = ledger.index || 0
    internalFlag = ledger.internalFlag || false
  }

  const path = makePath(account, index, internalFlag)

  /// Be sure disconnection process is finished.
  if (disconnection) {
    await disconnection
    disconnection = null
  }

  /// If the bip path is different we need to go through connect() again.
  if (ledger.path !== path) {
    connection = undefined
    ledger.publicKey = undefined
    ledger.path = path
    ledger.account = account || 0
    ledger.index = index || 0
    ledger.internalFlag = internalFlag || false
  }

  /// Connect & update data only when needed.
  if (!connection) connection = connect()
  return connection
}

function makePath (account, index, internalFlag) {
  let path = `44'/148'/${account}'`
  if (index || internalFlag) path += internalFlag ? "/1'" : "/0'"
  if (index) path += `/${index}'`

  return path
}

async function connect () {
  // eslint-disable-next-line no-console
  console.log("Attempting ledger connection...")
  ledger.error = undefined
  connection = true

  /// Try to connect until disconnect() is called or until connection happens.
  while (connection && !ledger.publicKey) {
    try {
      if (!ledger.transport || env.isNode) {
        ledger.transport = await Transport.create()
      }
      if (!ledger.application || env.isNode) {
        ledger.application = new StellarApp(ledger.transport)
      }
      /// Set ledger.publicKey
      Object.assign(ledger, await ledger.application.getPublicKey(ledger.path))
      await onConnect()
    } catch (error) {
      ledger.error = error
      if (error.id === "U2FNotSupported") {
        // This frame may show up when using strict Content-Security-Policy
        // See: https://github.com/LedgerHQ/ledgerjs/issues/254
        const iframeSelector = "iframe[src^=chrome-extension/*/u2f-comms.html]"
        const iframe = document.querySelector(iframeSelector)
        if (iframe) iframe.parentNode.removeChild(iframe)

        throw error
      }
      /// Have a timeout to avoid spamming application errors.
      await misc.timeout(1000)
    }
  }
}

/**
 * onConnect
 */
ledger.onConnect = null
async function onConnect () {
  // eslint-disable-next-line no-console
  console.log("Ledger connected")
  await refreshAppConfiguration()
  if (typeof ledger.onConnect === "function") ledger.onConnect()
  if (!isPolling) polling()
}

/**
 * OnDisconnect
 */
ledger.onDisconnect = null
function onDisconnect () {
  // eslint-disable-next-line no-console
  console.log("Ledger disconnected")
  if (typeof ledger.onDisconnect === "function") ledger.onDisconnect()
}

/**
 * Polling
 */
const pollingDelay = 500
let ping = false,
  isPolling = false
async function polling () {
  // eslint-disable-next-line no-console
  console.log("Start polling")
  isPolling = true
  const thisApplication = ledger.application
  while (isPolling && thisApplication === ledger.application) {
    ping = false
    await waitDevice()
    refreshAppConfiguration()
    await misc.timeout(pollingDelay)

    /// Timeout
    if (
      ping === false
      && (!ledger.transport || ledger.transport.disconnected !== false)
      && thisApplication === ledger.application
    ) {
      await ledger.disconnect()
    }
  }
  // eslint-disable-next-line no-console
  console.log("Stop polling")
}

async function refreshAppConfiguration () {
  try {
    /// Refresh ledger.multiOpsEnabled.
    Object.assign(ledger, await ledger.application.getAppConfiguration())
    ping = true
  } catch (error) {
    if (error.currentLock === "signTransaction") ping = true
  }
}

/**
 * Disconnect
 */

ledger.disconnect = async function () {
  isPolling = false
  const transport = ledger.transport
  if (transport) {
    disconnection = closeTransport(transport)
    disconnection.then(onDisconnect)
  } else {
    disconnection = undefined
  }
  reset()
  return disconnection
}

async function closeTransport (transport) {
  // If transport is not valid anymore we consider the transport as closed.
  try {
    transport.close()
  } catch (error) {
    console.error(error)
  }
}

function reset () {
  connection = null
  libValues.forEach(key => ledger[key] = null)
}

const libValues = [
  "transport",
  "application",
  "path",
  "account",
  "index",
  "internalFlag",
  "version",
  "publicKey",
  "multiOpsEnabled"
]

/**
 * Sign
 */

ledger.sign = async function (transaction) {
  if (!ledger.publicKey) throw new Error("No ledger wallet connected.")
  const StellarSdk = require("@cosmic-plus/base/es5/stellar-sdk")

  const app = ledger.application
  const signatureBase = transaction.signatureBase()
  await waitDevice()
  const result = await app.signTransaction(ledger.path, signatureBase)

  const keypair = StellarSdk.Keypair.fromPublicKey(ledger.publicKey)
  const hint = keypair.signatureHint()
  const decorated = new StellarSdk.xdr.DecoratedSignature({
    hint: hint,
    signature: result.signature
  })
  transaction.signatures.push(decorated)

  return transaction
}

/**
 * Device gets locked up while polling. This asynchronous function returns when
 * it is available.
 */
async function waitDevice () {
  while (ledger.transport && ledger.transport._appAPIlock) {
    await misc.timeout(100)
  }
}
