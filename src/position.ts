export interface LineCol {
  line: number;
  column: number;
}

/**
 * Running line/column tracker.
 *
 * Every string handed to the parser has already had its line endings
 * normalized to LF, so counting is a simple matter of locating the last LF.
 */
export class Position {
  line = 1;
  column = 1;

  snapshot(): LineCol {
    return {line: this.line, column: this.column};
  }

  advance(s: string, from = 0, to = s.length): void {
    if (to <= from) return;
    // Fast path: the overwhelming majority of spans contain no newline.
    let last = s.lastIndexOf('\n', to - 1);
    if (last < from) {
      this.column += to - from;
      return;
    }
    // Count newlines within [from, last].
    let count = 1;
    let idx = from - 1;
    while (true) {
      idx = s.indexOf('\n', idx + 1);
      if (idx >= last) break;
      count++;
    }
    this.line += count;
    this.column = to - last;
  }

  /** Position reached after walking `index` normalized characters from `base`. */
  static at(base: LineCol, s: string, index: number): LineCol {
    const p = new Position();
    p.line = base.line;
    p.column = base.column;
    p.advance(s, 0, index);
    return {line: p.line, column: p.column};
  }
}
