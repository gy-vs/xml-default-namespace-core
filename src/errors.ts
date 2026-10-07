/**
 * Thrown when the parser encounters malformed XML.
 * `line` and `column` are 1-based and point at the offending construct.
 */
export class SaxError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(reason: string, line: number, column: number) {
    super(`${reason} (line ${line}, column ${column})`);
    this.name = 'SaxError';
    this.line = line;
    this.column = column;
  }
}
