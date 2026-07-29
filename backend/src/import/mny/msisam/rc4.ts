/**
 * RC4 stream cipher.
 *
 * MSISAM (`.mny`) pages are RC4-encrypted. Node's OpenSSL 3 default provider
 * no longer offers RC4, so the cipher is implemented here rather than through
 * `crypto.createDecipheriv`. RC4 is symmetric: the same call encrypts and
 * decrypts.
 */

const STATE_SIZE = 256;

/**
 * Builds the RC4 key-scheduling state for the given key.
 */
function scheduleKey(key: Buffer): Uint8Array {
  const state = new Uint8Array(STATE_SIZE);
  for (let i = 0; i < STATE_SIZE; i++) {
    state[i] = i;
  }

  let j = 0;
  for (let i = 0; i < STATE_SIZE; i++) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    const swap = state[i];
    state[i] = state[j];
    state[j] = swap;
  }
  return state;
}

/**
 * Applies the RC4 keystream to `data` in place and returns the same buffer.
 *
 * Callers own `data`; nothing outside this module holds a reference to it.
 * Decrypting a 4 KB page allocates only the 256-byte cipher state, which is
 * what keeps whole-file decryption at zero extra memory (ADR-6).
 */
export function rc4InPlace(key: Buffer, data: Buffer): Buffer {
  const state = scheduleKey(key);

  let i = 0;
  let j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    const swap = state[i];
    state[i] = state[j];
    state[j] = swap;
    data[k] ^= state[(state[i] + state[j]) & 0xff];
  }
  return data;
}

/**
 * Applies the RC4 keystream to `data`, returning a new buffer and leaving the
 * input untouched. Used for the few-byte password check.
 */
export function rc4(key: Buffer, data: Buffer): Buffer {
  return rc4InPlace(key, Buffer.from(data));
}
