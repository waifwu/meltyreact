// Incremental SHA-256 (FIPS 180-4) in plain JavaScript.
//
// Why not crypto.subtle.digest: it takes one whole buffer and cannot be fed in
// chunks, and the archives reach 372 MB. Hashing them through it would mean
// holding a whole archive in memory. This implementation is fed the same chunks
// the importer is already copying, so hashing costs no extra I/O.
//
// The message length is tracked as a Number of bytes (exact up to 2^53) and
// split into high/low 32-bit words only when the final length block is written,
// so files past 2^29 bytes (2^32 bits) hash correctly.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  constructor() {
    this.h = new Int32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.w = new Int32Array(64);
    this.buf = new Uint8Array(64); // partial block
    this.bufLen = 0;
    this.length = 0; // total bytes, exact up to 2^53
    this.done = false;
  }

  /** Feed bytes (Uint8Array or ArrayBuffer). Returns this. */
  update(data) {
    if (this.done) throw new Error('Sha256: update after digest');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let pos = 0;
    const n = bytes.length;
    this.length += n;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, n);
      this.buf.set(bytes.subarray(0, take), this.bufLen);
      this.bufLen += take;
      pos = take;
      if (this.bufLen === 64) {
        this._block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (n - pos >= 64) {
      this._block(bytes, pos);
      pos += 64;
    }
    if (pos < n) {
      this.buf.set(bytes.subarray(pos), 0);
      this.bufLen = n - pos;
    }
    return this;
  }

  /** Finish and return the digest as a lowercase hex string. */
  hex() {
    const d = this.digest();
    let s = '';
    for (let i = 0; i < d.length; i++) s += d[i].toString(16).padStart(2, '0');
    return s;
  }

  /** Finish and return the 32-byte digest. */
  digest() {
    if (!this.done) {
      const bitsHi = Math.floor(this.length / 0x20000000); // length*8 / 2^32
      const bitsLo = (this.length * 8) >>> 0;
      const pad = new Uint8Array(this.bufLen < 56 ? 64 - this.bufLen : 128 - this.bufLen);
      pad[0] = 0x80;
      const dv = new DataView(pad.buffer);
      dv.setUint32(pad.length - 8, bitsHi, false);
      dv.setUint32(pad.length - 4, bitsLo, false);
      const savedLen = this.length;
      this.update(pad);
      this.length = savedLen;
      this.done = true;
    }
    const out = new Uint8Array(32);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) dv.setUint32(i * 4, this.h[i], false);
    return out;
  }

  _block(b, p) {
    const w = this.w;
    for (let i = 0; i < 16; i++, p += 4) {
      w[i] = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this.h;
    let a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
}

/** One-shot helper. */
export function sha256Hex(data) {
  return new Sha256().update(data).hex();
}
