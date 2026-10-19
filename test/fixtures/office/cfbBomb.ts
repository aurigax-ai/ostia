export function cfbBomb(sectors: number): Uint8Array {
  const P = sectors
  const T = sectors
  const SSZ = 512
  const ENDCHAIN = -2
  const FATSECT = -3
  const FREE = -1
  const total0 = 1 + T + P
  const F = Math.ceil((total0 + 10) / 127)
  const N = F + 1 + T + P
  const fat = new Int32Array(F * 128).fill(FREE)
  for (let i = 0; i < F; i++) fat[i] = FATSECT
  const dir = F
  fat[dir] = ENDCHAIN
  const tail = F + 1
  for (let i = 0; i < T; i++) fat[tail + i] = i === T - 1 ? ENDCHAIN : tail + i + 1
  for (let i = 0; i < P; i++) fat[tail + T + i] = tail
  const buf = new Uint8Array(SSZ * (N + 1))
  const dv = new DataView(buf.buffer, 0, buf.length)
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  buf.set(sig)
  dv.setUint16(24, 0x3e, true)
  dv.setUint16(26, 3, true)
  dv.setUint16(28, 0xfffe, true)
  dv.setUint16(30, 9, true)
  dv.setUint16(32, 6, true)
  dv.setInt32(44, F, true)
  dv.setInt32(48, dir, true)
  dv.setUint32(56, 4096, true)
  dv.setInt32(60, ENDCHAIN, true)
  dv.setInt32(64, 0, true)
  dv.setInt32(68, ENDCHAIN, true)
  dv.setInt32(72, 0, true)
  for (let j = 0; j < 109; j++) dv.setInt32(76 + 4 * j, j < F ? j : FREE, true)
  const sec = (s: number) => SSZ * (s + 1)
  for (let i = 0; i < F * 128; i++) dv.setInt32(sec(0) + 4 * i, fat[i], true)
  const d = sec(dir)
  const name = 'Root Entry'
  for (let i = 0; i < name.length; i++) dv.setUint16(d + 2 * i, name.charCodeAt(i), true)
  dv.setUint16(d + 64, (name.length + 1) * 2, true)
  buf[d + 66] = 5
  dv.setInt32(d + 68, -1, true)
  dv.setInt32(d + 72, -1, true)
  dv.setInt32(d + 76, -1, true)
  dv.setInt32(d + 116, ENDCHAIN, true)
  for (let e = 1; e < 4; e++) {
    dv.setInt32(d + e * 128 + 68, -1, true)
    dv.setInt32(d + e * 128 + 72, -1, true)
    dv.setInt32(d + e * 128 + 76, -1, true)
  }
  return buf
}
