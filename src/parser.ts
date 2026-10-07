import {Chunker} from './chunk.js';
import {SaxError} from './errors.js';
import {NamespaceContext, XMLNS_NS_URI, XML_NS_URI} from './nscontext.js';
import {Position, type LineCol} from './position.js';

/** A namespace-resolved name. `uri === ''` means "in no namespace". */
export interface QName {
  prefix: string;
  local: string;
  uri: string;
}

export interface Attribute {
  name: QName;
  value: string;
}

export interface SaxHandlers {
  startDocument?(): void;
  endDocument?(): void;
  startElement?(name: QName, attributes: Attribute[]): void;
  endElement?(name: QName): void;
  text?(text: string): void;
  cdata?(text: string): void;
  comment?(text: string): void;
  processingInstruction?(target: string, data: string): void;
}

export interface SaxOptions {
  handlers?: SaxHandlers;
  /** Size hint (in characters) for streaming text/cdata events. Default 65536. */
  textChunkSize?: number;
}

type State =
  | 'init'
  | 'content'
  | 'entity'
  | 'startTag'
  | 'endTag'
  | 'comment'
  | 'cdata'
  | 'piTarget'
  | 'piBody'
  | 'doctype';

interface RawAttribute {
  qname: string;
  /** Fully decoded attribute value (entities expanded, endings normalized). */
  value: string;
}

interface ElementFrame {
  qname: string;
  prefix: string;
  local: string;
  uri: string;
}

// Illegal XML 1.0 characters other than unpaired surrogates (legal: #x9
// #xA #xD, #x20-#xD7FF, #xE000-#xFFFD, #x10000-#x10FFFF). Valid surrogate
// pairs are stripped before this check; FFFE/FFFF and lone surrogates are
// handled separately. Escapes are written with \xNN to keep the source ASCII.
const ILLEGAL_CHAR_RE = new RegExp(
  '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F' +
    String.fromCharCode(0xfffe, 0xffff) +
    ']',
);
const SURROGATE_RE = new RegExp(
  `[${String.fromCharCode(0xd800)}-${String.fromCharCode(0xdfff)}]`,
);
const S_OUTSIDE_RE = /[^ \t\n]/;
const ENTITY_MAX = 96;
const MARKUP_MAX = 1 << 24; // 16 MB guard for fully-buffered constructs

/**
 * Validate an XML Name (allowColon) or NCName (disallow colon) by code point,
 * per the NameChar classes of XML 1.0 fifth edition.
 */
function isValidName(s: string, allowColon: boolean): boolean {
  const n = s.length;
  if (n === 0) return false;

  // Fast path for the overwhelmingly common all-ASCII case.
  let ascii = true;
  for (let i = 0; i < n; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    let c = s.charCodeAt(0);
    const firstOk =
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x5f ||
      (allowColon && c === 0x3a);
    if (!firstOk) return false;
    for (let i = 1; i < n; i++) {
      c = s.charCodeAt(i);
      const ok =
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0x30 && c <= 0x39) ||
        c === 0x5f ||
        c === 0x2d ||
        c === 0x2e ||
        (allowColon && c === 0x3a);
      if (!ok) return false;
    }
    return true;
  }

  let i = 0;
  let first = true;
  while (i < n) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      if (i + 1 >= n) return false;
      const low = s.charCodeAt(i + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
      i += 2;
    } else {
      if (cp >= 0xdc00 && cp <= 0xdfff) return false;
      i += 1;
    }
    if (first ? !isNameStartCp(cp, allowColon) : !isNameCharCp(cp, allowColon)) {
      return false;
    }
    first = false;
  }
  return true;
}

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

const NAME_START_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x41, 0x5a],
  [0x61, 0x7a],
  [0xc0, 0xd6],
  [0xd8, 0xf6],
  [0xf8, 0x2ff],
  [0x370, 0x37d],
  [0x37f, 0x1fff],
  [0x200c, 0x200d],
  [0x2070, 0x218f],
  [0x2c00, 0x2fef],
  [0x3001, 0xd7ff],
  [0xf900, 0xfdcf],
  [0xfdf0, 0xfffd],
  [0x10000, 0xeffff],
];

const NAME_CHAR_EXTRA_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2d, 0x2e],
  [0x30, 0x39],
  [0xb7, 0xb7],
  [0x300, 0x36f],
  [0x203f, 0x2040],
];

function isNameStartCp(cp: number, allowColon: boolean): boolean {
  return (allowColon && cp === 0x3a) || cp === 0x5f || inRanges(cp, NAME_START_RANGES);
}

function isNameCharCp(cp: number, allowColon: boolean): boolean {
  return isNameStartCp(cp, allowColon) || inRanges(cp, NAME_CHAR_EXTRA_RANGES);
}

type Sink = (s: string) => void;

export class SaxParser {
  private handlers: SaxHandlers;
  private chunkSize: number;

  private state: State = 'init';
  private tail = '';
  private errored = false;
  private closed = false;
  private started = false;

  private decoder!: TextDecoder;
  private encoder = new TextEncoder();
  private position = new Position();
  private ns = new NamespaceContext();
  private textChunker!: Chunker;
  private cdataChunker!: Chunker;

  /** Document structure state. */
  private elementStack: ElementFrame[] = [];
  private seenRoot = false;
  private finished = false;
  private doctypeSeen = false;
  private declSeen = false;
  private prologMarkupSeen = false;

  /** Cross-run dangling CR in element text content. */
  private contentPendingCR = false;
  /** Cross-run dangling CR inside a markup construct (attr/comment/PI/...). */
  private markupPendingCR = false;

  /** Position captured at the start of the current markup/entity token. */
  private tokenStart: LineCol = {line: 1, column: 1};

  /**
   * Buffered raw bytes of the start/end tag currently being accumulated,
   * excluding the leading '<' / '</' and trailing '>'. Tags are fully
   * buffered (capped at MARKUP_MAX) then parsed in one pass.
   */
  private tagPieces: string[] = [];
  private tagSize = 0;
  /** Quote char open inside the buffered tag, so '>' in a value is safe. */
  private tagQuote = '';

  /** Entity reference being read (after the leading &). */
  private entityPieces: string[] = [];
  private entitySize = 0;

  /** Fully buffered, size-capped constructs. */
  private commentPieces: string[] = [];
  private commentSize = 0;
  private piTargetPieces: string[] = [];
  private piBodyPieces: string[] = [];
  private piSize = 0;
  private doctypePieces: string[] = [];
  private doctypeSize = 0;
  private doctypeQuote = '';

  constructor(options: SaxOptions = {}) {
    this.handlers = options.handlers ?? {};
    this.chunkSize = options.textChunkSize ?? 1 << 16;
    this.init();
  }

  private init(): void {
    this.state = 'init';
    this.tail = '';
    this.errored = false;
    this.closed = false;
    this.started = false;
    this.decoder = new TextDecoder('utf-8', {fatal: true});
    this.position = new Position();
    this.ns = new NamespaceContext();
    this.textChunker = new Chunker(this.chunkSize, (t) =>
      this.handlers.text?.(t),
    );
    this.cdataChunker = new Chunker(this.chunkSize, (t) =>
      this.handlers.cdata?.(t),
    );
    this.elementStack = [];
    this.seenRoot = false;
    this.finished = false;
    this.doctypeSeen = false;
    this.declSeen = false;
    this.prologMarkupSeen = false;
    this.contentPendingCR = false;
    this.markupPendingCR = false;
    this.tokenStart = {line: 1, column: 1};
    this.tagPieces = [];
    this.tagSize = 0;
    this.tagQuote = '';
    this.entityPieces = [];
    this.entitySize = 0;
    this.commentPieces = [];
    this.commentSize = 0;
    this.piTargetPieces = [];
    this.piBodyPieces = [];
    this.piSize = 0;
    this.doctypePieces = [];
    this.doctypeSize = 0;
    this.doctypeQuote = '';
  }

  /** Reset every scrap of state so the next document parses like a fresh parser. */
  reset(): void {
    this.init();
  }

  on<K extends keyof SaxHandlers>(event: K, handler: NonNullable<SaxHandlers[K]>): this {
    this.handlers[event] = handler;
    return this;
  }

  // ---------------------------------------------------------------- feed data

  /**
   * Feed one network chunk. Bytes are decoded as UTF-8; a multi-byte character
   * split across chunks is reassembled transparently. Strings are accepted for
   * convenience and re-encoded as UTF-8.
   */
  write(chunk: Uint8Array | string): this {
    if (this.errored) {
      throw new SaxError(
        'parser is in an error state; call reset() before feeding a new document',
        this.position.line,
        this.position.column,
      );
    }
    if (this.closed) {
      throw new SaxError(
        'document already closed; call reset() to parse another document',
        this.position.line,
        this.position.column,
      );
    }
    if (!this.started) {
      this.started = true;
      this.handlers.startDocument?.();
    }
    const bytes = typeof chunk === 'string' ? this.encoder.encode(chunk) : chunk;
    let decoded: string;
    try {
      decoded = this.decoder.decode(bytes, {stream: true});
    } catch {
      this.failHere('invalid UTF-8 byte sequence');
    }
    this.tail += decoded;
    this.run();
    return this;
  }

  /** Signal end of input. Throws if any construct is unterminated. */
  close(): void {
    if (this.errored) {
      throw new SaxError(
        'parser is in an error state; call reset() before feeding a new document',
        this.position.line,
        this.position.column,
      );
    }
    if (this.closed) {
      throw new SaxError('document already closed', this.position.line, this.position.column);
    }
    this.closed = true;
    if (!this.started) this.handlers.startDocument?.();
    let decoded: string;
    try {
      decoded = this.decoder.decode();
    } catch {
      this.failHere('invalid UTF-8 byte sequence');
    }
    this.tail += decoded;
    this.run();

    // Any state other than plain content means a construct was opened but not
    // finished (a half-read tag, comment, CDATA, PI...), even if no tail
    // characters remain buffered.
    if (
      this.state !== 'content' &&
      this.state !== 'init'
    ) {
      this.failAt(this.tokenStart, this.eofMessage());
    }
    if (this.tail.length > 0 || this.elementStack.length > 0) {
      this.failAt(this.tokenStart, this.eofMessage());
    }
    if (!this.seenRoot) this.failHere('document has no root element');
    if (this.contentPendingCR) {
      this.contentPendingCR = false;
      this.emitContent('\n');
    }
    this.textChunker.flush();
    this.handlers.endDocument?.();
  }

  private eofMessage(): string {
    switch (this.state) {
      case 'entity':
        return 'unterminated entity reference';
      case 'startTag':
        return 'unclosed start tag';
      case 'endTag':
        return 'unclosed end tag';
      case 'comment':
        return 'unclosed comment';
      case 'cdata':
        return 'unclosed CDATA section';
      case 'piTarget':
      case 'piBody':
        return 'unclosed processing instruction';
      case 'doctype':
        return 'unclosed DOCTYPE declaration';
      default: {
        const top = this.elementStack[this.elementStack.length - 1];
        return top ? `unclosed element <${top.qname}>` : 'unexpected end of input';
      }
    }
  }

  // ------------------------------------------------------------- tokenizer

  private run(): void {
    while (this.tail.length > 0) {
      const before = this.tail.length;
      // Fast path: the parser spends almost all its time in content state.
      if (this.state === 'content') {
        this.parseContent();
        if (this.tail.length >= before) break;
        continue;
      }
      switch (this.state) {
        case 'init':
          this.parseInit();
          break;
        case 'entity':
          this.parseEntity();
          break;
        case 'startTag':
          this.parseStartTag();
          break;
        case 'endTag':
          this.parseEndTag();
          break;
        case 'comment':
          this.parseComment();
          break;
        case 'cdata':
          this.parseCdata();
          break;
        case 'piTarget':
          this.parsePiTarget();
          break;
        case 'piBody':
          this.parsePiBody();
          break;
        case 'doctype':
          this.parseDoctype();
          break;
      }
      // A handler that consumed nothing is waiting for the next chunk.
      if (this.tail.length >= before) break;
    }
  }

  private retain(n: number, state: State): void {
    if (n > 0) this.tail = this.tail.slice(n);
    this.state = state;
  }

  private parseInit(): void {
    if (this.tail.charCodeAt(0) === 0xfeff) {
      this.retain(1, 'content'); // BOM is consumed but not counted in line/column
    } else {
      this.state = 'content';
    }
    this.parseContent();
  }

  private parseContent(): void {
    const b = this.tail;

    // Resolve a CR held at the end of the previous run against the character
    // that now follows it. This is the only place contentPendingCR is consumed.
    if (this.contentPendingCR) {
      if (b.charCodeAt(0) === 0x0a) {
        // CRLF split across runs: the held CR and this LF are one line break.
        // Position for the CR was already counted; consume this LF silently.
        this.tail = b.slice(1);
        return;
      }
      // The held CR begins a line of its own.
      this.contentPendingCR = false;
      this.emitContent('\n');
    }

    const lt = b.indexOf('<');
    let cut: number;
    if (lt === -1) {
      const amp = b.indexOf('&');
      cut = amp === -1 ? b.length : amp;
    } else {
      const amp = b.indexOf('&');
      cut = amp === -1 ? lt : Math.min(lt, amp);
    }

    // Consume plain content up to the marker. If that content ends with CR,
    // the CR is undecidable until the next character: hold it back (counting
    // its position now) and set pendingCR.
    let end = cut;
    let trailingCR = false;
    if (end > 0 && b.charCodeAt(end - 1) === 0x0d) {
      end -= 1;
      trailingCR = true;
    }
    if (end > 0) this.emitRawContent(b.slice(0, end));

    if (cut === b.length) {
      if (trailingCR) {
        this.position.advance('\r');
        this.contentPendingCR = true;
      }
      this.retain(cut, 'content');
      return;
    }

    if (trailingCR) {
      // The marker ('<' or '&') is the character following the CR, so the CR
      // cannot start a CRLF pair and becomes a line break on its own.
      this.position.advance('\r');
      this.emitContent('\n');
    }

    this.tokenStart = this.position.snapshot();

    if (b.charCodeAt(cut) === 0x26) {
      this.position.advance(b, cut, cut + 1);
      this.entityPieces = [];
      this.entitySize = 0;
      this.retain(cut + 1, 'entity');
      return;
    }
    this.enterMarkup(cut);
  }

  /** Normalize CR/CRLF in raw content and emit it as text. */
  private emitRawContent(s: string): void {
    const hasCR = s.indexOf('\r') !== -1;
    const body = hasCR ? s.replace(/\r\n?/g, '\n') : s;
    if (body.length === 0) return;
    this.checkLegal(body, this.position.snapshot());
    this.position.advance(body);
    this.emitContent(body);
  }

  private emitContent(s: string): void {
    this.contentSink(s);
  }

  /**
   * Called once a '<' is confirmed to start a markup construct. Resolves any
   * dangling CR against the boundary and delivers buffered text so the
   * upcoming event stays in document order regardless of chunking.
   */
  private beginMarkup(b: string, from: number, to: number): void {
    // The caller (parseContent) has already resolved a dangling CR; here we
    // only deliver buffered text so the upcoming event stays in order.
    this.textChunker.flush();
    this.position.advance(b, from, to);
  }

  private enterMarkup(i: number): void {
    const b = this.tail;
    if (b.length - i < 2) {
      this.retain(i, 'content'); // '<' with nothing after it yet; hold unconsumed
      return;
    }
    const c = b.charCodeAt(i + 1);
    if (c === 0x2f) {
      this.beginMarkup(b, i, i + 2);
      this.tagPieces = [];
      this.tagSize = 0;
      this.tagQuote = '';
      this.retain(i + 2, 'endTag');
      return;
    }
    if (c === 0x3f) {
      this.beginMarkup(b, i, i + 2);
      this.piTargetPieces = [];
      this.piBodyPieces = [];
      this.piSize = 0;
      this.retain(i + 2, 'piTarget');
      return;
    }
    if (this.isNameStartCode(c)) {
      this.beginMarkup(b, i, i + 1);
      this.tagPieces = [];
      this.tagSize = 0;
      this.tagQuote = '';
      this.retain(i + 1, 'startTag');
      return;
    }
    if (c === 0x21) {
      this.enterBang(i);
      return;
    }
    this.failAt(this.tokenStart, 'malformed markup: unexpected character after <');
  }

  private enterBang(i: number): void {
    const b = this.tail;
    if (b.length <= i + 2) {
      this.retain(i, 'content');
      return;
    }
    const c = b.charCodeAt(i + 2);
    if (c === 0x2d) {
      if (b.length <= i + 3) {
        this.retain(i, 'content');
        return;
      }
      if (b.charCodeAt(i + 3) !== 0x2d) {
        this.failAt(this.tokenStart, 'malformed markup: expected <!--');
      }
      this.beginMarkup(b, i, i + 4);
      this.commentPieces = [];
      this.commentSize = 0;
      this.retain(i + 4, 'comment');
      return;
    }
    if (c === 0x5b) {
      const kw = '[CDATA[';
      for (let k = 1; k < kw.length; k++) {
        if (b.length <= i + 2 + k) {
          this.retain(i, 'content');
          return;
        }
        if (b.charCodeAt(i + 2 + k) !== kw.charCodeAt(k)) {
          this.failAt(this.tokenStart, 'malformed markup: expected <![CDATA[');
        }
      }
      if (this.elementStack.length === 0) {
        this.failAt(this.tokenStart, 'CDATA section is only allowed inside an element');
      }
      this.beginMarkup(b, i, i + 9);
      this.cdataChunker.clear();
      this.retain(i + 9, 'cdata');
      return;
    }
    if (c === 0x44) {
      const kw = 'DOCTYPE';
      for (let k = 1; k < kw.length; k++) {
        if (b.length <= i + 2 + k) {
          this.retain(i, 'content');
          return;
        }
        if (b.charCodeAt(i + 2 + k) !== kw.charCodeAt(k)) {
          this.failAt(this.tokenStart, 'unsupported or malformed markup after <!');
        }
      }
      this.beginMarkup(b, i, i + 9);
      this.doctypePieces = [];
      this.doctypeSize = 0;
      this.doctypeQuote = '';
      this.retain(i + 9, 'doctype');
      return;
    }
    this.failAt(this.tokenStart, 'unsupported or malformed markup after <!');
  }

  // ------------------------------------------------------------- text entities

  private parseEntity(): void {
    const b = this.tail;
    const semi = b.indexOf(';');
    if (semi === -1) {
      this.entitySize += b.length;
      if (this.entitySize > ENTITY_MAX) {
        this.failAt(this.tokenStart, 'malformed entity reference: no terminating semicolon');
      }
      this.entityPieces.push(b);
      this.position.advance(b, 0, b.length);
      this.retain(b.length, 'entity');
      return;
    }
    this.position.advance(b, 0, semi + 1);
    const ref = this.entityPieces.join('') + b.slice(0, semi);
    // Expansion replaces the (already counted) raw reference; position is
    // unchanged, the value just needs validation.
    const value = this.resolveEntity(ref);
    this.checkLegal(value, this.tokenStart);
    this.contentSink(value);
    this.retain(semi + 1, 'content');
  }

  private resolveEntity(ref: string): string {
    if (ref.length === 0 || ref.length > ENTITY_MAX) {
      this.failAt(this.tokenStart, 'malformed entity reference');
    }
    if (ref[0] === '#') {
      let cp: number;
      if (ref.length > 1 && (ref[1] === 'x' || ref[1] === 'X')) {
        if (!/^[0-9a-fA-F]+$/.test(ref.slice(2))) {
          this.failAt(this.tokenStart, `illegal hexadecimal character reference &#${ref.slice(1)};`);
        }
        cp = parseInt(ref.slice(2), 16);
      } else {
        if (!/^[0-9]+$/.test(ref.slice(1))) {
          this.failAt(this.tokenStart, `illegal decimal character reference &#${ref.slice(1)};`);
        }
        cp = parseInt(ref.slice(1), 10);
      }
      const legal =
        cp === 0x09 ||
        cp === 0x0a ||
        cp === 0x0d ||
        (cp >= 0x20 && cp <= 0xd7ff) ||
        (cp >= 0xe000 && cp <= 0xfffd) ||
        (cp >= 0x10000 && cp <= 0x10ffff);
      if (!legal) {
        this.failAt(this.tokenStart, `illegal character reference &#${ref.slice(1)};`);
      }
      return String.fromCodePoint(cp);
    }
    if (!isValidName(ref, true)) {
      this.failAt(this.tokenStart, `malformed entity reference &${ref};`);
    }
    switch (ref) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'apos':
        return "'";
      case 'quot':
        return '"';
      default:
        this.failAt(
          this.tokenStart,
          `undeclared entity &${ref}; (only the five predefined entities and character references are allowed)`,
        );
    }
  }

  // ----------------------------------------------------------- element tags

  /**
   * Accumulate an entire start tag (everything between '<' and '>') then
   * parse it in one pass. A '>' inside a quoted attribute value does not end
   * the tag, so the open quote is tracked across runs. Position is advanced
   * once, over the line-ending-normalized form, when the tag completes.
   */
  private parseStartTag(): void {
    const b = this.tail;
    let quote = this.tagQuote;
    let i = 0;
    while (i < b.length) {
      const c = b[i];
      if (quote !== '') {
        if (c === quote) quote = '';
        i += 1;
      } else if (c === '"' || c === "'") {
        quote = c;
        i += 1;
      } else if (c === '>') {
        break;
      } else {
        i += 1;
      }
    }

    if (i === b.length) {
      // Closing '>' not yet seen; keep buffering (capped).
      if (this.tagSize + b.length > MARKUP_MAX) {
        this.failAt(this.tokenStart, 'start tag exceeds 16 MB limit');
      }
      this.tagPieces.push(b);
      this.tagSize += b.length;
      this.tagQuote = quote;
      this.retain(b.length, 'startTag');
      return;
    }

    const raw = this.tagPieces.length === 0 ? b.slice(0, i) : this.tagPieces.join('') + b.slice(0, i);
    this.tagPieces = [];
    this.tagSize = 0;
    this.tagQuote = '';
    const tag = raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n');
    this.position.advance(tag, 0, tag.length);
    this.position.advance(b, i, i + 1); // the closing '>'
    this.retain(i + 1, 'content');
    this.processStartTag(tag);
  }

  /** Parse the normalized interior of a start tag (no leading '<'/trailing '>'). */
  private processStartTag(tag: string): void {
    const n = tag.length;
    let i = 0;
    const skipWs = () => {
      while (i < n && this.isWSCode(tag.charCodeAt(i))) i++;
    };
    const failHere = (offset: number, reason: string): never =>
      this.failAt(Position.at(this.tokenStart, tag, offset), reason);

    const nameStart = i;
    while (i < n && !this.isWSCode(tag.charCodeAt(i)) && tag.charCodeAt(i) !== 0x2f) i++;
    const element = tag.slice(nameStart, i);
    if (element.length === 0) {
      failHere(nameStart, 'malformed start tag: invalid element name');
    }

    const attrs: RawAttribute[] = [];
    let selfClosing = false;
    while (i < n) {
      skipWs();
      if (i >= n) break;
      if (tag.charCodeAt(i) === 0x2f) {
        i++;
        skipWs();
        if (i !== n) failHere(i, 'malformed start tag: expected > after /');
        selfClosing = true;
        break;
      }
      const anStart = i;
      while (i < n) {
        const c = tag.charCodeAt(i);
        if (
          this.isWSCode(c) ||
          c === 0x3d ||
          c === 0x2f ||
          c === 0x3e ||
          c === 0x22 ||
          c === 0x27 ||
          c === 0x3c
        ) {
          break;
        }
        i++;
      }
      if (i === anStart) failHere(i, 'malformed start tag near attribute list');
      const attrName = tag.slice(anStart, i);
      skipWs();
      if (i >= n || tag.charCodeAt(i) !== 0x3d) {
        failHere(i, 'malformed start tag: expected = after attribute name');
      }
      i++;
      skipWs();
      const qc = tag.charCodeAt(i);
      if (qc !== 0x22 && qc !== 0x27) {
        failHere(i, 'malformed start tag: attribute value must be quoted');
      }
      i++;
      const vStart = i;
      while (i < n && tag.charCodeAt(i) !== qc) i++;
      if (i >= n) failHere(i, 'malformed start tag: unterminated attribute value');
      const valueRaw = tag.slice(vStart, i);
      i++; // closing quote
      if (valueRaw.indexOf('<') !== -1) {
        failHere(vStart + valueRaw.indexOf('<'), 'illegal "<" in attribute value');
      }
      this.checkLegal(valueRaw, Position.at(this.tokenStart, tag, vStart));
      attrs.push({qname: attrName, value: this.expandEntities(valueRaw)});
    }

    this.buildStartElement(element, attrs, selfClosing, tag);
  }

  private buildStartElement(
    element: string,
    rawAttrs: RawAttribute[],
    selfClosing: boolean,
    tag: string,
  ): void {
    const posAt = (offset: number) => Position.at(this.tokenStart, tag, offset);
    const elementName = this.splitQName(element, posAt(0), 'element name');

    if (!this.seenRoot) {
      this.seenRoot = true;
    } else if (this.elementStack.length === 0) {
      this.failAt(this.tokenStart, 'document has multiple root elements');
    }

    // Pass 1: collect namespace declarations with all well-formedness checks.
    const declarations: Array<[string, string]> = [];
    const seenPrefixes = new Set<string>();
    const outputAttrs: RawAttribute[] = [];
    for (const attr of rawAttrs) {
      const isDefaultDecl = attr.qname === 'xmlns';
      const isPrefixedDecl = attr.qname.startsWith('xmlns:');
      if (!isDefaultDecl && !isPrefixedDecl) {
        outputAttrs.push(attr);
        continue;
      }
      const value = attr.value;
      let prefix: string;
      if (isDefaultDecl) {
        prefix = '';
        if (value === XMLNS_NS_URI) {
          this.failAt(this.tokenStart, 'cannot bind the reserved xmlns namespace as default');
        }
      } else {
        prefix = attr.qname.slice(6);
        if (prefix === 'xmlns' || prefix.includes(':')) {
          this.failAt(this.tokenStart, 'illegal namespace declaration prefix');
        }
        if (!isValidName(prefix, false)) {
          this.failAt(this.tokenStart, `illegal namespace prefix "${prefix}"`);
        }
        if (value === '') {
          this.failAt(this.tokenStart, 'cannot undeclare a prefixed namespace (XML 1.0)');
        }
        if (prefix === 'xml') {
          if (value !== XML_NS_URI) {
            this.failAt(this.tokenStart, 'the xml prefix is permanently bound to ' + XML_NS_URI);
          }
        } else if (value === XML_NS_URI) {
          this.failAt(this.tokenStart, 'only the xml prefix may be bound to ' + XML_NS_URI);
        }
        if (value === XMLNS_NS_URI) {
          this.failAt(this.tokenStart, 'cannot bind the reserved xmlns namespace to a prefix');
        }
      }
      if (seenPrefixes.has(prefix)) {
        this.failAt(this.tokenStart, `duplicate namespace declaration for prefix "${prefix}"`);
      }
      seenPrefixes.add(prefix);
      declarations.push([prefix, value]);
    }

    if (declarations.length === 0) this.ns.pushEmpty();
    else this.ns.push(declarations);

    let uri: string;
    if (elementName.prefix === '') {
      uri = this.ns.lookup('') ?? '';
    } else {
      const resolved = this.ns.lookup(elementName.prefix);
      if (resolved === null) {
        this.failAt(
          this.tokenStart,
          `unbound namespace prefix "${elementName.prefix}" on element <${element}>`,
        );
      }
      uri = resolved;
    }

    // Pass 2: resolve ordinary attributes (xmlns declarations are not attributes).
    const attributes: Attribute[] = [];
    const seenAttrKeys = new Set<string>();
    for (const attr of outputAttrs) {
      const parts = this.splitQName(attr.qname, this.tokenStart, 'attribute name');
      let attrUri = '';
      if (parts.prefix !== '') {
        const resolved = this.ns.lookup(parts.prefix);
        if (resolved === null) {
          this.failAt(
            this.tokenStart,
            `unbound namespace prefix "${parts.prefix}" on attribute ${attr.qname}`,
          );
        }
        attrUri = resolved;
      }
      const key = attrUri + ' ' + parts.local;
      if (seenAttrKeys.has(key)) {
        this.failAt(
          this.tokenStart,
          `duplicate attribute ${attrUri === '' ? '' : '{' + attrUri + '}'}${parts.local}`,
        );
      }
      seenAttrKeys.add(key);
      attributes.push({
        name: {prefix: parts.prefix, local: parts.local, uri: attrUri},
        value: attr.value,
      });
    }
    void posAt;

    const resolvedName: QName = {prefix: elementName.prefix, local: elementName.local, uri};
    this.elementStack.push({
      qname: element,
      prefix: elementName.prefix,
      local: elementName.local,
      uri,
    });
    this.handlers.startElement?.(resolvedName, attributes);

    if (selfClosing) {
      this.handlers.endElement?.(resolvedName);
      this.elementStack.pop();
      this.ns.pop();
      if (this.elementStack.length === 0) this.finished = true;
    }
    this.state = 'content';
  }

  /**
   * Expand entities in a line-ending-normalized attribute value. The value
   * has already passed character legality through the value-reading path.
   */
  private expandEntities(value: string): string {
    const amp = value.indexOf('&');
    if (amp === -1) return value;
    let out = '';
    let i = 0;
    let at = amp;
    while (at !== -1) {
      out += value.slice(i, at);
      const semi = value.indexOf(';', at + 1);
      if (semi === -1 || semi - at - 1 > ENTITY_MAX) {
        this.failAt(this.tokenStart, 'malformed entity reference in attribute value');
      }
      out += this.resolveEntity(value.slice(at + 1, semi));
      i = semi + 1;
      at = value.indexOf('&', i);
    }
    out += value.slice(i);
    return out;
  }

  // ------------------------------------------------------------- end element

  /** Accumulate an end tag up to its closing '>'. */
  private parseEndTag(): void {
    const b = this.tail;
    const gt = b.indexOf('>');
    if (gt === -1) {
      if (this.tagSize + b.length > MARKUP_MAX) {
        this.failAt(this.tokenStart, 'end tag exceeds 16 MB limit');
      }
      this.tagPieces.push(b);
      this.tagSize += b.length;
      this.retain(b.length, 'endTag');
      return;
    }
    const raw = this.tagPieces.length === 0 ? b.slice(0, gt) : this.tagPieces.join('') + b.slice(0, gt);
    this.tagPieces = [];
    this.tagSize = 0;
    const tag = raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n');
    this.position.advance(tag, 0, tag.length);
    this.position.advance(b, gt, gt + 1);
    this.retain(gt + 1, 'content');
    this.processEndTag(tag);
  }

  private processEndTag(tag: string): void {
    const n = tag.length;
    let i = 0;
    while (i < n && !this.isWSCode(tag.charCodeAt(i))) i++;
    const qname = tag.slice(0, i);
    while (i < n && this.isWSCode(tag.charCodeAt(i))) i++;
    if (i !== n) {
      this.failAt(this.tokenStart, 'malformed end tag: expected >');
    }
    if (qname.length === 0) {
      this.failAt(this.tokenStart, 'malformed end tag: invalid element name');
    }
    const parts = this.splitQName(qname, this.tokenStart, 'element name');
    if (parts.prefix !== '' && this.ns.lookup(parts.prefix) === null) {
      this.failAt(this.tokenStart, `unbound namespace prefix "${parts.prefix}" in end tag`);
    }
    const top = this.elementStack[this.elementStack.length - 1];
    if (!top || top.qname !== qname) {
      this.failAt(
        this.tokenStart,
        top
          ? `mismatched end tag </${qname}>; expected </${top.qname}>`
          : `unexpected end tag </${qname}> with no open element`,
      );
    }
    this.ns.pop();
    this.elementStack.pop();
    this.handlers.endElement?.({prefix: top.prefix, local: top.local, uri: top.uri});
    if (this.elementStack.length === 0) this.finished = true;
    this.state = 'content';
  }


  // ----------------------------------------------------------------- comment

  private parseComment(): void {
    const b = this.tail;
    // Hold the last two characters: the terminator '-->' may be split there.
    const limit = b.length - 2;
    if (limit <= 0) {
      this.retain(0, 'comment');
      return;
    }
    const end = b.indexOf('-->');
    if (end !== -1 && end <= limit) {
      // A double dash is illegal anywhere inside the comment body, including
      // one immediately before the terminator ("... -- -->").
      if (b.slice(0, end).includes('--')) {
        this.failAt(this.tokenStart, 'illegal "--" inside comment');
      }
      this.feedComment(b.slice(0, end));
      this.flushMarkupCR((s) => {
        this.commentSize += s.length;
        this.commentPieces.push(s);
      });
      this.position.advance(b, end, end + 3);
      const text = this.commentPieces.join('');
      this.commentPieces = [];
      this.commentSize = 0;
      this.markProlog();
      this.handlers.comment?.(text);
      this.retain(end + 3, 'content');
      return;
    }
    // Detect '--' whose following character is fully visible and not '>'.
    for (let i = 0; i + 2 < b.length; i++) {
      if (b.charCodeAt(i) === 0x2d && b.charCodeAt(i + 1) === 0x2d && b.charCodeAt(i + 2) !== 0x3e) {
        this.failAt(this.tokenStart, 'illegal "--" inside comment');
      }
    }
    // Hold back from the last possible '--' start so a split terminator can
    // never be mistaken for an illegal double dash (or vice versa).
    let stop = limit;
    const last = b.lastIndexOf('--', b.length - 2);
    if (last !== -1) stop = Math.min(stop, last);
    this.feedComment(b.slice(0, stop));
    this.retain(stop, 'comment');
  }

  private feedComment(s: string): void {
    if (s.length === 0) return;
    if (this.commentSize + s.length > MARKUP_MAX) {
      this.failAt(this.tokenStart, 'comment exceeds 16 MB limit');
    }
    this.feedRaw(s, (v) => {
      this.commentSize += v.length;
      this.commentPieces.push(v);
    });
  }

  // ------------------------------------------------------------------ cdata

  private parseCdata(): void {
    const b = this.tail;
    // The terminator is three characters, so the last two characters are
    // always held for the next run (or close()). They are neither counted
    // nor delivered now; the next run rescans them together with new input.
    const limit = b.length - 2;
    if (limit <= 0) {
      this.retain(0, 'cdata');
      return;
    }
    const terminator = b.indexOf(']]>');
    if (terminator !== -1 && terminator <= limit) {
      this.feedCdata(b.slice(0, terminator));
      this.flushMarkupCR((s) => this.cdataChunker.push(s));
      this.position.advance(b, terminator, terminator + 3);
      this.cdataChunker.flush();
      this.retain(terminator + 3, 'content');
      return;
    }
    // A ']]' beginning inside the consumable region could be the terminator
    // prefix; stop at the first such bracket so it is rescanned next run.
    let stop = limit;
    const pair = b.lastIndexOf(']]', limit);
    if (pair !== -1) stop = pair;
    this.feedCdata(b.slice(0, stop));
    this.retain(stop, 'cdata');
  }

  private feedCdata(s: string): void {
    if (s.length === 0) return;
    this.feedRaw(s, (v) => this.cdataChunker.push(v));
  }

  // -------------------------------------------------------- processing instr

  private parsePiTarget(): void {
    const b = this.tail;
    let i = 0;
    while (i < b.length) {
      const c = b.charCodeAt(i);
      if (c === 0x3f || this.isWSCode(c)) break;
      i++;
    }
    if (i === b.length) {
      this.piTargetPieces.push(b);
      this.growPi(b.length);
      this.position.advance(b, 0, b.length);
      this.retain(b.length, 'piTarget');
      return;
    }
    this.piTargetPieces.push(b.slice(0, i));
    this.position.advance(b, 0, i);
    if (b.charCodeAt(i) === 0x3f) {
      if (b.length - i < 2) {
        // Hold a dangling '?' so '?>' split across chunks stays deterministic.
        this.retain(i, 'piTarget');
        return;
      }
      this.growPi(1);
      this.position.advance(b, i, i + 1);
      if (b.charCodeAt(i + 1) !== 0x3e) {
        this.failAt(this.tokenStart, 'malformed processing instruction');
      }
      this.position.advance(b, i + 1, i + 2);
      this.completePi(i + 2);
      return;
    }
    this.growPi(1);
    this.feedRaw(b.slice(i, i + 1), this.noSink);
    this.retain(i + 1, 'piBody');
  }

  private parsePiBody(): void {
    const b = this.tail;
    // Hold the final character: the two-character terminator '?>' may be split.
    const limit = b.length - 1;
    if (limit <= 0) {
      this.retain(0, 'piBody');
      return;
    }
    const end = b.indexOf('?>');
    if (end !== -1 && end <= limit) {
      this.feedPi(b.slice(0, end));
      this.flushMarkupCR((s) => {
        this.piSize += s.length;
        this.piBodyPieces.push(s);
      });
      this.position.advance(b, end, end + 2);
      this.completePi(end + 2);
      return;
    }
    // A trailing '?' could be the first half of a split terminator; hold it.
    const stop = b.charCodeAt(limit - 1) === 0x3f ? limit - 1 : limit;
    this.feedPi(b.slice(0, stop));
    this.retain(stop, 'piBody');
  }

  private feedPi(s: string): void {
    if (s.length === 0) return;
    if (this.piSize + s.length > MARKUP_MAX) {
      this.failAt(this.tokenStart, 'processing instruction exceeds 16 MB limit');
    }
    this.feedRaw(s, (v) => {
      this.piSize += v.length;
      this.piBodyPieces.push(v);
    });
  }

  private growPi(n: number): void {
    this.piSize += n;
    if (this.piSize > MARKUP_MAX) {
      this.failAt(this.tokenStart, 'processing instruction exceeds 16 MB limit');
    }
  }

  private completePi(consumed: number): void {
    const target = this.piTargetPieces.join('');
    if (target.length === 0 || !isValidName(target, false)) {
      this.failAt(this.tokenStart, 'malformed processing instruction: invalid target name');
    }
    if (/^xml/i.test(target) && target !== 'xml') {
      this.failAt(this.tokenStart, `processing instruction target "${target}" is reserved`);
    }
    if (target === 'xml') {
      // XML declaration: legal only at the absolute start of the document
      // (after the BOM), i.e. line 1 column 1 — not even leading whitespace.
      if (
        this.declSeen ||
        this.prologMarkupSeen ||
        this.doctypeSeen ||
        this.seenRoot ||
        this.tokenStart.line !== 1 ||
        this.tokenStart.column !== 1
      ) {
        this.failAt(this.tokenStart, 'XML declaration is only allowed at the start of the document');
      }
      const data = this.piBodyPieces.join('').trim();
      this.parseXmlDecl(data);
      this.declSeen = true;
    } else {
      const data = this.piBodyPieces.join('').replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
      this.markProlog();
      this.handlers.processingInstruction?.(target, data);
    }
    this.piTargetPieces = [];
    this.piBodyPieces = [];
    this.piSize = 0;
    this.retain(consumed, 'content');
  }

  private parseXmlDecl(data: string): void {
    let i = 0;
    const seen = new Set<string>();
    let gotVersion = false;
    while (i < data.length) {
      while (i < data.length && this.isWSCode(data.charCodeAt(i))) i++;
      if (i === data.length) break;
      let j = i;
      while (j < data.length && !this.isWSCode(data.charCodeAt(j)) && data[j] !== '=') j++;
      const name = data.slice(i, j);
      if (!isValidName(name, false)) this.failAt(this.tokenStart, 'malformed XML declaration');
      i = j;
      while (i < data.length && this.isWSCode(data.charCodeAt(i))) i++;
      if (data[i] !== '=') this.failAt(this.tokenStart, 'malformed XML declaration');
      i++;
      while (i < data.length && this.isWSCode(data.charCodeAt(i))) i++;
      const q = data[i];
      if (q !== '"' && q !== "'") this.failAt(this.tokenStart, 'malformed XML declaration');
      i++;
      j = i;
      while (j < data.length && data[j] !== q) j++;
      if (j === data.length) this.failAt(this.tokenStart, 'malformed XML declaration');
      const value = data.slice(i, j);
      i = j + 1;

      if (seen.has(name)) {
        this.failAt(this.tokenStart, `duplicate "${name}" in XML declaration`);
      }
      seen.add(name);
      if (name === 'version') {
        if (!/^1\.[0-9]+$/.test(value)) {
          this.failAt(this.tokenStart, `unsupported XML version "${value}"`);
        }
        gotVersion = true;
      } else if (name === 'encoding') {
        if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(value)) {
          this.failAt(this.tokenStart, `invalid encoding "${value}" in XML declaration`);
        }
      } else if (name === 'standalone') {
        if (value !== 'yes' && value !== 'no') {
          this.failAt(this.tokenStart, 'standalone must be "yes" or "no"');
        }
      } else {
        this.failAt(this.tokenStart, `unknown attribute "${name}" in XML declaration`);
      }
    }
    if (!gotVersion) this.failAt(this.tokenStart, 'XML declaration requires a version');
  }

  // ----------------------------------------------------------------- doctype

  private parseDoctype(): void {
    const b = this.tail;
    let i = 0;
    let quote = this.doctypeQuote;
    while (i < b.length) {
      const c = b[i];
      if (quote !== '') {
        if (c === quote) quote = '';
        i++;
      } else if (c === '"' || c === "'") {
        quote = c;
        i++;
      } else if (c === '[') {
        this.failAt(this.tokenStart, 'internal DTD subsets (entity declarations) are not allowed');
      } else if (c === '>') {
        break;
      } else {
        i++;
      }
    }
    const consumed = i === b.length ? b.length : i;
    if (consumed > 0) {
      if (this.doctypeSize + consumed > MARKUP_MAX) {
        this.failAt(this.tokenStart, 'DOCTYPE exceeds 16 MB limit');
      }
      this.doctypeSize += consumed;
      this.feedRaw(b.slice(0, consumed), (v) => this.doctypePieces.push(v));
    }
    this.doctypeQuote = quote;
    if (i === b.length) {
      this.retain(b.length, 'doctype');
      return;
    }
    this.flushMarkupCR((s) => this.doctypePieces.push(s));
    this.position.advance(b, i, i + 1);
    this.completeDoctype(i + 1);
  }

  private completeDoctype(consumed: number): void {
    if (this.seenRoot || this.finished) {
      this.failAt(this.tokenStart, 'DOCTYPE must appear before the root element');
    }
    if (this.doctypeSeen) {
      this.failAt(this.tokenStart, 'multiple DOCTYPE declarations');
    }
    const text = this.doctypePieces.join('');
    this.validateDoctype(text);
    this.doctypeSeen = true;
    this.doctypePieces = [];
    this.doctypeSize = 0;
    this.doctypeQuote = '';
    this.retain(consumed, 'content');
  }

  private validateDoctype(text: string): void {
    let i = 0;
    const skipWs = () => {
      while (i < text.length && this.isWSCode(text.charCodeAt(i))) i++;
    };
    const readName = (): string => {
      const start = i;
      while (i < text.length && !this.isWSCode(text.charCodeAt(i))) i++;
      return text.slice(start, i);
    };
    const readQuoted = (): void => {
      const q = text[i];
      if (q !== '"' && q !== "'") {
        this.failAt(this.tokenStart, 'malformed DOCTYPE: quoted literal expected');
      }
      i++;
      const start = i;
      while (i < text.length && text[i] !== q) i++;
      if (i === text.length) {
        this.failAt(this.tokenStart, 'malformed DOCTYPE: unterminated quoted literal');
      }
      if (i === start) this.failAt(this.tokenStart, 'malformed DOCTYPE: empty literal');
      i++;
    };

    skipWs();
    const name = readName();
    if (name.length === 0 || !isValidName(name, true)) {
      this.failAt(this.tokenStart, 'malformed DOCTYPE: missing or invalid root name');
    }
    skipWs();
    if (i < text.length) {
      const kind = readName();
      if (kind === 'SYSTEM') {
        skipWs();
        readQuoted();
      } else if (kind === 'PUBLIC') {
        skipWs();
        readQuoted();
        skipWs();
        readQuoted();
      } else {
        this.failAt(this.tokenStart, `malformed DOCTYPE near "${kind}"`);
      }
      skipWs();
      if (i !== text.length) {
        this.failAt(this.tokenStart, 'malformed DOCTYPE: trailing content');
      }
    }
  }

  // -------------------------------------------------- normalization / sinks

  /**
   * Normalize CR / CRLF line endings inside a markup construct (attribute
   * value, comment, PI body, DOCTYPE).
   *
   * A trailing CR is held as markupPendingCR (already counted) and decided by
   * the next character: LF makes it one CRLF line break; anything else makes
   * it a lone LF. Uses its own pending flag so it never shares state with
   * element-text normalization.
   */
  private feedRaw(s: string, sink: Sink): void {
    if (s.length === 0) return;

    // Fast path: no carriage return anywhere and none pending.
    if (!this.markupPendingCR && s.indexOf('\r') === -1) {
      this.checkLegal(s, this.position.snapshot());
      this.position.advance(s);
      sink(s);
      return;
    }

    let out = '';

    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x0d) {
        if (this.markupPendingCR) out += '\n'; // a previous lone CR
        this.markupPendingCR = true; // this CR awaits the next character
      } else {
        if (this.markupPendingCR) {
          this.markupPendingCR = false;
          out += '\n';
          if (c === 0x0a) continue; // CR LF is a single line break
        }
        out += s[i];
      }
    }

    if (out.length > 0) {
      this.checkLegal(out, this.position.snapshot());
      this.position.advance(out);
      sink(out);
    }
  }

  /** Resolve a dangling markup CR at a construct boundary as a lone LF. */
  private flushMarkupCR(sink: Sink): void {
    if (!this.markupPendingCR) return;
    this.markupPendingCR = false;
    sink('\n');
  }

  private readonly noSink: Sink = () => {};

  private readonly contentSink: Sink = (s: string) => {
    if (this.elementStack.length === 0) {
      if (S_OUTSIDE_RE.test(s)) {
        this.failHere('text is not allowed outside the root element');
      }
      return;
    }
    this.textChunker.push(s);
  };

  private markProlog(): void {
    if (!this.seenRoot) this.prologMarkupSeen = true;
  }

  // ------------------------------------------------------------- validation

  private checkLegal(s: string, base: LineCol): void {
    // Native regex scans are far faster than a JS character loop and return
    // null immediately for the overwhelmingly common well-formed strings.
    const bad = ILLEGAL_CHAR_RE.exec(s);
    const surr = SURROGATE_RE.exec(s);
    if (!bad && !surr) return;

    if (!surr) {
      this.failAt(
        Position.at(base, s, bad!.index),
        'illegal XML character (control character)',
      );
    }

    // Surrogates need pair validation; astral content (emoji etc.) is legal.
    for (let i = 0; i < s.length; i++) {
      const cu = s.charCodeAt(i);
      if (cu >= 0xd800 && cu <= 0xdbff) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          i++;
          continue;
        }
        this.failAt(Position.at(base, s, i), 'illegal XML character (unpaired surrogate)');
      }
      if (cu >= 0xdc00 && cu <= 0xdfff) {
        this.failAt(Position.at(base, s, i), 'illegal XML character (unpaired surrogate)');
      }
    }
    if (bad) {
      this.failAt(
        Position.at(base, s, bad.index),
        'illegal XML character (control character)',
      );
    }
  }

  private splitQName(
    qname: string,
    pos: LineCol,
    what: string,
  ): {prefix: string; local: string} {
    const colon = qname.indexOf(':');
    if (colon === -1) {
      if (!isValidName(qname, false)) {
        this.failAt(pos, `illegal ${what} "${qname}"`);
      }
      return {prefix: '', local: qname};
    }
    const prefix = qname.slice(0, colon);
    const local = qname.slice(colon + 1);
    if (
      local.includes(':') ||
      prefix.length === 0 ||
      local.length === 0 ||
      !isValidName(prefix, false) ||
      !isValidName(local, false)
    ) {
      this.failAt(pos, `illegal ${what} "${qname}"`);
    }
    return {prefix, local};
  }

  private isWSCode(c: number): boolean {
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
  }

  private isNameStartCode(c: number): boolean {
    return (
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x5f ||
      c >= 0x80
    );
  }

  // ---------------------------------------------------------------- errors

  private failAt(pos: LineCol, reason: string): never {
    this.errored = true;
    throw new SaxError(reason, pos.line, pos.column);
  }

  private failHere(reason: string): never {
    this.errored = true;
    const p = this.position.snapshot();
    throw new SaxError(reason, p.line, p.column);
  }
}
