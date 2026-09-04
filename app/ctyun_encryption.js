const crypto = require('crypto');

class CtYunEncryption {
  constructor() {
    this.authMechanism = 1;
  }

  execute(data) {
    const inbound = data.subarray(16);
    // 提取 N (129 字节，从 32 开始)
    const nBuf = inbound.subarray(32, 32 + 129);
    // 提取 E (3 字节，从 163 开始)
    const eBuf = inbound.subarray(163, 163 + 3);
    const e = (eBuf[0] << 16) | (eBuf[1] << 8) | eBuf[2];

    const nHex = nBuf.toString('hex');
    const n = BigInt('0x' + nHex);

    // RSA-OAEP 填充与加密
    const encrypted = this.oaepEncrypt(128, '', n, BigInt(e));

    // 封装报文: Little Endian 4 字节 authMechanism + encrypted
    const result = Buffer.alloc(4 + encrypted.length);
    result.writeUInt32LE(this.authMechanism, 0);
    encrypted.copy(result, 4);
    return result;
  }

  oaepEncrypt(keyLen, label, n, e) {
    const seed = crypto.randomBytes(20);
    const hLen = 20; // SHA1 长度
    const dbLen = keyLen - hLen - 1;
    const db = Buffer.alloc(dbLen);

    // lHash
    const lHash = crypto.createHash('sha1').update(label).digest();
    lHash.copy(db, 0);
    db[db.length - 1 - label.length - 1] = 1;

    // MGF1 掩码处理
    const dbMask = this.mgf1(seed, dbLen);
    for (let k = 0; k < dbLen; k++) {
      db[k] ^= dbMask[k];
    }

    const seedMask = this.mgf1(db, hLen);
    for (let k = 0; k < hLen; k++) {
      seed[k] ^= seedMask[k];
    }

    // 拼接: 00 || MaskedSeed || MaskedDB
    const em = Buffer.alloc(keyLen);
    seed.copy(em, 1);
    db.copy(em, 1 + hLen);

    // RSA 加密: c = m^e mod n
    const m = BigInt('0x' + em.toString('hex'));
    const c = this.modPow(m, e, n);

    let hex = c.toString(16);
    if (hex.length % 2 !== 0) hex = '0' + hex;
    const resultBytes = Buffer.from(hex, 'hex');

    if (resultBytes.length === keyLen) return resultBytes;
    const finalBuf = Buffer.alloc(keyLen);
    resultBytes.copy(finalBuf, keyLen - resultBytes.length);
    return finalBuf;
  }

  mgf1(seed, maskLen) {
    const mask = Buffer.alloc(maskLen);
    const counter = Buffer.alloc(4);
    let offset = 0;
    let n = 0;

    while (offset < maskLen) {
      counter.writeUInt32BE(n, 0);
      const hash = crypto.createHash('sha1').update(Buffer.concat([seed, counter])).digest();
      const copyLen = Math.min(hash.length, maskLen - offset);
      hash.copy(mask, offset, 0, copyLen);
      offset += hash.length;
      n++;
    }
    return mask;
  }

  modPow(base, exp, mod) {
    let res = 1n;
    base = base % mod;
    while (exp > 0n) {
      if (exp % 2n === 1n) res = (res * base) % mod;
      base = (base * base) % mod;
      exp = exp / 2n;
    }
    return res;
  }
}

module.exports = CtYunEncryption;
