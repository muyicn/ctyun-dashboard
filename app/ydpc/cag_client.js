const net = require('net');
const crypto = require('crypto');

const CAG_MAGIC = Buffer.from('ZTEC,\x00', 'binary');
const AUTH_TYPE_RADIUS = 1;

function ipTo16Bytes(host) {
  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
  if (isIpv4) {
    const parts = host.split('.').map(Number);
    const buf = Buffer.alloc(16, 0);
    buf[0] = parts[0];
    buf[1] = parts[1];
    buf[2] = parts[2];
    buf[3] = parts[3];
    return buf;
  }
  // IPv6 fallback
  const buf = Buffer.alloc(16, 0);
  return buf;
}

function deriveAesKeyIv(clientKey, serverKey) {
  const mixedClient = (clientKey & 0xABACACAB) >>> 0;
  const mixedServer = (serverKey | 0x98979798) >>> 0;

  const b0 = mixedClient & 0xFF;
  const b1 = (mixedClient >> 8) & 0xFF;
  const b2 = (mixedClient >> 16) & 0xFF;
  const b3 = (mixedClient >> 24) & 0xFF;

  const ms0 = mixedServer & 0xFF;
  const ms1 = (mixedServer >> 8) & 0xFF;
  const ms2 = (mixedServer >> 16) & 0xFF;
  const ms3 = (mixedServer >> 24) & 0xFF;

  const padHex = (n, len = 2) => n.toString(16).padStart(len, '0');
  const padHex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');

  const keyStr = `${padHex8(clientKey)}${padHex8(serverKey)}${padHex(ms0)}${padHex(ms3)}${padHex(ms2)}${padHex(ms1)}${padHex(b3)}${padHex(b1)}${padHex(b0)}${padHex(b2)}`;
  const ivStr = `02x${padHex(b0).toUpperCase()}${padHex(b1).toUpperCase()}${padHex(b3)}02x${padHex(ms2)}${padHex(ms3)}`;

  return {
    key: Buffer.from(keyStr, 'ascii').subarray(0, 32),
    iv: Buffer.from(ivStr, 'ascii').subarray(0, 16)
  };
}

function cagAesEncrypt(plaintext, clientKey, serverKey, aesFlag) {
  const { key: keyMaterial, iv } = deriveAesKeyIv(clientKey, serverKey);
  const bits = (aesFlag & 1) ? 256 : 128;
  const key = keyMaterial.subarray(0, bits / 8);

  let paddedPlain = plaintext;
  if (paddedPlain.length % 16 !== 0) {
    const padLen = 16 - (paddedPlain.length % 16);
    paddedPlain = Buffer.concat([paddedPlain, Buffer.alloc(padLen, 0)]);
  }

  const isCbc = !!(aesFlag & 0x100);
  const algorithm = isCbc ? (bits === 256 ? 'aes-256-cbc' : 'aes-128-cbc') : (bits === 256 ? 'aes-256-ecb' : 'aes-128-ecb');

  const cipher = isCbc ? crypto.createCipheriv(algorithm, key, iv) : crypto.createCipheriv(algorithm, key, null);
  cipher.setAutoPadding(false);

  return Buffer.concat([cipher.update(paddedPlain), cipher.final()]);
}

function xorWithKey99(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ 99;
  }
  return out;
}

function buildZtecStage1(vmId, clientKey) {
  const kmBuf = Buffer.alloc(16, 0);
  Buffer.from(vmId.slice(0, 16), 'ascii').copy(kmBuf);

  const payload = Buffer.alloc(44);
  payload.writeUInt32LE(AUTH_TYPE_RADIUS + 100, 0);
  payload.writeUInt32LE(clientKey >>> 0, 4);
  payload.writeUInt32LE(220, 8);
  kmBuf.copy(payload, 12, 0, 16);
  // 12 bytes zeros at 28
  payload.writeUInt32LE(0x03, 40);

  return Buffer.concat([CAG_MAGIC, payload]);
}

function parseZtecStage2(blob) {
  if (blob.length < 50) throw new Error(`Stage 2 expected 50 bytes, got ${blob.length}`);
  const payload = blob.subarray(6);
  const serverKey = payload.readUInt32LE(4);
  const flags = payload.readUInt32LE(40);

  let aesFlag = (flags & 1) ? 2 : 1;
  if (flags & 2) aesFlag |= 0x100;

  return { serverKey, aesFlag };
}

function buildZtecStage3Radius(destHost, destPort, username, password, clientKey, serverKey, aesFlag) {
  const usernameBuf = Buffer.alloc(64, 0);
  Buffer.from(username.slice(0, 63), 'ascii').copy(usernameBuf);

  const passwordBuf = Buffer.alloc(64, 0);
  Buffer.from(password.slice(0, 63), 'ascii').copy(passwordBuf);

  const pkt = Buffer.alloc(220, 0);
  pkt.writeUInt16LE(destPort, 0);
  ipTo16Bytes(destHost).copy(pkt, 4, 0, 16);

  const encUser = cagAesEncrypt(usernameBuf, clientKey, serverKey, aesFlag);
  encUser.copy(pkt, 60, 0, 64);

  const encPwd = cagAesEncrypt(xorWithKey99(passwordBuf), clientKey, serverKey, aesFlag);
  encPwd.copy(pkt, 124, 0, 64);

  return pkt;
}

/**
 * 执行中兴 CAG TCP 三阶段握手与连接保持
 */
async function performCagAuthHold(firmAuth, holdSeconds = 3, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const cagHost = String(firmAuth.cagIp || firmAuth.cagHost);
    const cagPort = Number(firmAuth.cagPort || 8899);
    const vmcHost = String(firmAuth.vmcIp || firmAuth.vmcHost || cagHost);
    const vmcPort = Number(firmAuth.vmcPort || firmAuth.cagPort || 8899);
    const vmUserName = String(firmAuth.vmUserName || '');
    const vmPassword = String(firmAuth.vmPassword || '');
    const vmId = String(firmAuth.vmId || '');

    const clientKey = crypto.randomBytes(4).readUInt32LE(0);
    const socket = new net.Socket();
    let stage = 1;
    let recvBuffer = Buffer.alloc(0);
    let holdTimer = null;
    let timeoutTimer = null;

    const cleanup = () => {
      if (holdTimer) clearTimeout(holdTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      socket.destroy();
    };

    timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`CAG TCP 握手超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    socket.connect(cagPort, cagHost, () => {
      // 1. 发送 Stage 1
      const stage1Buf = buildZtecStage1(vmId, clientKey);
      socket.write(stage1Buf);
    });

    socket.on('data', (chunk) => {
      recvBuffer = Buffer.concat([recvBuffer, chunk]);

      if (stage === 1) {
        // 等待 Stage 2 (50 字节)
        if (recvBuffer.length >= 50) {
          try {
            const { serverKey, aesFlag } = parseZtecStage2(recvBuffer.subarray(0, 50));
            recvBuffer = recvBuffer.subarray(50);
            stage = 2;

            // 2. 发送 Stage 3
            const stage3Buf = buildZtecStage3Radius(
              vmcHost,
              vmcPort,
              vmUserName,
              vmPassword,
              clientKey,
              serverKey,
              aesFlag
            );
            socket.write(stage3Buf);
          } catch (err) {
            cleanup();
            reject(err);
          }
        }
      } else if (stage === 2) {
        // 等待 Stage 4 (CAG Reply，通常含 200 OK)
        const text = recvBuffer.toString('ascii');
        if (text.includes('200') || recvBuffer.length >= 4) {
          stage = 3;
          // 握手成功，保持连接若干秒后优雅退出
          holdTimer = setTimeout(() => {
            cleanup();
            resolve({ success: true, cagCode: 200, message: 'ZTEC CAG 握手成功，网关已确认活跃' });
          }, holdSeconds * 1000);
        }
      }
    });

    socket.on('error', (err) => {
      cleanup();
      reject(err);
    });

    socket.on('close', () => {
      if (stage === 3) {
        resolve({ success: true, cagCode: 200, message: 'ZTEC CAG 握手成功' });
      }
    });
  });
}

module.exports = {
  performCagAuthHold,
  buildZtecStage1,
  parseZtecStage2,
  buildZtecStage3Radius,
  deriveAesKeyIv
};
