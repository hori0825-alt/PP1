// 位置シーク・後埋め (placeholder patch) に対応した拡張可能バイナリライタ

export class BinWriter {
  private buf = new Uint8Array(4096);
  private len = 0;
  private pos = 0;

  get position(): number {
    return this.pos;
  }

  seek(p: number): void {
    this.pos = p;
  }

  private ensure(n: number): void {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
    if (this.pos > this.len) this.len = this.pos;
  }

  bytes(arr: ArrayLike<number>): void {
    this.ensure(arr.length);
    this.buf.set(arr as Uint8Array, this.pos);
    this.pos += arr.length;
    if (this.pos > this.len) this.len = this.pos;
  }

  fill(byte: number, count: number): void {
    for (let i = 0; i < count; i++) this.u8(byte);
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i) & 0xff);
  }

  u16(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
  }

  u24(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
    this.u8(v >> 16);
  }

  u32(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
    this.u8(v >> 16);
    this.u8(v >> 24);
  }

  f32(v: number): void {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, true);
    this.u8(dv.getUint8(0));
    this.u8(dv.getUint8(1));
    this.u8(dv.getUint8(2));
    this.u8(dv.getUint8(3));
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
