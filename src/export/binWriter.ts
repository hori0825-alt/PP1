// 成長するバッファへのバイナリ書き込みユーティリティ。

export class BinWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(initialCapacity);
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  bytes(data: ArrayLike<number>): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  /** ASCII 文字列 (1文字1バイト) */
  ascii(s: string): void {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) {
      this.buf[this.len++] = s.charCodeAt(i) & 0xff;
    }
  }

  u16le(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
  }

  u16be(v: number): void {
    this.u8(v >> 8);
    this.u8(v);
  }

  u24le(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
    this.u8(v >> 16);
  }

  u32le(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
    this.u8(v >> 16);
    this.u8(v >> 24);
  }

  /** 指定バイト値で count バイト埋める */
  fill(value: number, count: number): void {
    this.ensure(count);
    this.buf.fill(value & 0xff, this.len, this.len + count);
    this.len += count;
  }

  /** 書き込み済み領域の任意位置を後から上書きする (プレースホルダー解決用) */
  patchU32le(offset: number, v: number): void {
    this.buf[offset] = v & 0xff;
    this.buf[offset + 1] = (v >> 8) & 0xff;
    this.buf[offset + 2] = (v >> 16) & 0xff;
    this.buf[offset + 3] = (v >> 24) & 0xff;
  }

  patchU24le(offset: number, v: number): void {
    this.buf[offset] = v & 0xff;
    this.buf[offset + 1] = (v >> 8) & 0xff;
    this.buf[offset + 2] = (v >> 16) & 0xff;
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
