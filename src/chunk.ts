/**
 * Collects a stream of strings and re-emits it in fixed-size chunks.
 *
 * Chunk boundaries depend only on the number of characters pushed in, never
 * on how the input happened to be split across network packets, which is what
 * makes event streams identical for every chunking of the same document.
 * Surrogate pairs are never split across two chunks.
 */
export class Chunker {
  #buf = '';

  constructor(
    readonly size: number,
    private readonly emit: (chunk: string) => void,
  ) {}

  push(s: string): void {
    if (s.length === 0) return;
    const b = this.#buf + s;
    let off = 0;
    while (b.length - off >= this.size) {
      let cut = off + this.size;
      // Never separate a high surrogate from the low surrogate that follows.
      const before = b.charCodeAt(cut - 1);
      if (before >= 0xd800 && before <= 0xdbff && cut < b.length) cut--;
      this.emit(b.slice(off, cut));
      off = cut;
    }
    this.#buf = off === 0 ? b : b.slice(off);
  }

  /** Emit any buffered tail as a final chunk. No event is produced when empty. */
  flush(): void {
    const b = this.#buf;
    if (b.length > 0) {
      this.#buf = '';
      this.emit(b);
    }
  }

  clear(): void {
    this.#buf = '';
  }
}
