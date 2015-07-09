var CryptoJS = require("crypto-js")
var Transaction = require('ethereumjs-tx')
var EC = require('elliptic').ec
var ec = new EC('secp256k1')
var Mnemonic = require('bitcore-mnemonic')
var bitcore = require('bitcore')

var KeyStore = function(mnemonic, password) {

    this.encSeed = undefined;
    this.encMasterPriv = undefined;
    this.keyHash = undefined;
    this.salt = undefined;
    this.hdIndex = 0;
    this.encPrivKeys = {};
    this.addresses = [];
    if ((typeof password !== 'undefined') && (typeof mnemonic !== 'undefined')){

      if (!Mnemonic.isValid(mnemonic, Mnemonic.Words.ENGLISH)){
        throw new Error("KeyStore: Invalid mnemonic");
      }
      this.salt = CryptoJS.lib.WordArray.random(128 / 8);
      var masterKey = CryptoJS.PBKDF2(password, this.salt, {keysize: 512 / 32, iterations: 500}).toString();
      this.keyHash = CryptoJS.SHA3(masterKey).toString();

      this.encSeed = KeyStore._encryptString(mnemonic, masterKey);
      var master = new Mnemonic(mnemonic).toHDPrivateKey().xprivkey;
      this.encMasterPriv = KeyStore._encryptString(master, masterKey);
    }
}

KeyStore._encryptString = function (string, password) {
    var encObj = CryptoJS.AES.encrypt(string, password);
    var encString = { 'encStr': encObj.toString(),
                    'iv': encObj.iv.toString(),
                    'salt': encObj.salt.toString()}
    return encString
}

KeyStore._decryptString = function (encryptedStr, password) {
    var decryptedStr = CryptoJS.AES.decrypt(encryptedStr.encStr, password, {'iv': encryptedStr.iv, 'salt': encryptedStr.salt });
    return decryptedStr.toString(CryptoJS.enc.Latin1);
}

KeyStore._encryptKey = function (privKey, password) {
    var privKeyWordArray = CryptoJS.enc.Hex.parse(privKey)
    var encKey = CryptoJS.AES.encrypt(privKeyWordArray, password);
    var encKey = { 'key': encKey.toString(),
                    'iv': encKey.iv.toString(),
                    'salt': encKey.salt.toString()}
    return encKey
}

KeyStore._decryptKey = function (encryptedKey, password) {
    var decryptedKey = CryptoJS.AES.decrypt(encryptedKey.key, password, {'iv': encryptedKey.iv, 'salt': encryptedKey.salt });
    return decryptedKey.toString(CryptoJS.enc.Hex);
}

KeyStore._computeAddressFromPrivKey = function (privKey) {
    var keyPair = ec.genKeyPair()
    keyPair._importPrivate(privKey, 'hex')
    var compact = false
    var pubKey = keyPair.getPublic(compact, 'hex').slice(2)
    var pubKeyWordArray = CryptoJS.enc.Hex.parse(pubKey)
    var hash = CryptoJS.SHA3(pubKeyWordArray, { outputLength: 256 })
    var address = hash.toString(CryptoJS.enc.Hex).slice(24)

    return address
}

KeyStore.prototype._addKeyPair = function (privKey, address, password) {
    var masterKey = this.generateMKey(password)
    var encPrivKey = KeyStore._encryptKey(privKey, masterKey)

    this.encPrivKeys[address] = encPrivKey
    this.addresses.push(address)
}

KeyStore.prototype._generatePrivKey = function(password) {
    var masterKey = this.generateMKey(password)
    var master = KeyStore._decryptString(this.encMasterPriv, masterKey);
    var key = new bitcore.HDPrivateKey(master).derive(this.hdIndex++);

    return key.privateKey.toString()
}

// External static functions

KeyStore.generateRandomSeed = function() {
    var seed = new Mnemonic(Mnemonic.Words.ENGLISH)
    return seed.toString()
}

// Takes keystore serialized as string and returns an instance of KeyStore
KeyStore.deserialize = function (keystore) {
    jsonKS = JSON.parse(keystore)

    // Create keystore
    var keystore = new KeyStore()

    keystore.encSeed = jsonKS.encSeed
    keystore.encMasterPriv = jsonKS.encMasterPriv
    keystore.hdIndex = jsonKS.hdIndex
    keystore.encPrivKeys = jsonKS.encPrivKeys
    keystore.addresses = jsonKS.addresses
    keystore.salt = jsonKS.salt
    keystore.keyHash = jsonKS.keyHash
    return keystore
}

// External API functions

KeyStore.prototype.serialize = function () {
    var jsonKS = {"encSeed": this.encSeed,
                "encMasterPriv": this.encMasterPriv,
                "hdIndex": this.hdIndex,
                "encPrivKeys": this.encPrivKeys,
                "addresses": this.addresses,
                "salt": this.salt,
                "keyHash": this.keyHash}

    return JSON.stringify(jsonKS)
}

KeyStore.prototype.getAddresses = function () {
    return this.addresses;
}

KeyStore.prototype.getSeed = function (password) {
    var masterKey = this.generateMKey(password)
    var seed = KeyStore._decryptString(this.encSeed, masterKey);
    return seed;
}

KeyStore.prototype.exportPrivateKey = function (address, password) {
    if (this.encPrivKeys[address] === undefined) {
        throw new Error("KeyStore.exportPrivateKey: Address not found in KeyStore")
    }
    var encKey = this.encPrivKeys[address]
    var masterKey = this.generateMKey(password)

    var privKey = KeyStore._decryptKey(encKey, masterKey)

    return privKey;
}

KeyStore.prototype.generateNewAddress = function(password) {
    if (!this.encSeed) {
        throw new Error("KeyStore.generateNewAddress: No seed set");
    }

    var privateKey = this._generatePrivKey(password)
    var address = KeyStore._computeAddressFromPrivKey(privateKey)
    this._addKeyPair(privateKey, address, password)

    return address
}

KeyStore.prototype.signTx = function (rawTx, password, signingAddress) {

    if (this.addresses.length === 0) {
        throw new Error("KeyStore.signTx: No private keys in KeyStore.")
    }

    var address = ''
    if (signingAddress === undefined) {
        address = this.addresses[0]
    }
    else {
        if (this.encPrivKeys[signingAddress] === undefined) {
            throw new Error("KeyStore.signTx: Address not found in KeyStore")
        }
        address = signingAddress
    }

    var txCopy = new Transaction(new Buffer(rawTx, 'hex'))
    var encPrivKey = this.encPrivKeys[address]
    var masterKey = this.generateMKey(password)

    var privKey = KeyStore._decryptKey(encPrivKey, masterKey)
    var addrFromPrivKey = KeyStore._computeAddressFromPrivKey(privKey)
    if (addrFromPrivKey !== address) {
        throw new Error("KeyStore.signTx: Decrypting private key failed!")
    }
    txCopy.sign(new Buffer(privKey, 'hex'));
    privKey = ''

    return txCopy.serialize().toString('hex')
}

KeyStore.prototype.generateMKey = function(password) {
    var masterKey = CryptoJS.PBKDF2(password, this.salt, {keysize: 512 / 32, iterations: 500}).toString();
    if (CryptoJS.SHA3(masterKey).toString() !== this.keyHash){
      throw new Error('Invalid Password');
    }
    return masterKey
}

module.exports = KeyStore;
