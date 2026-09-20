/**
 * Streaming XML parser with per-element namespace scoping.
 *
 * Every start element pushes one namespace scope frame holding the
 * declarations found on that element; the matching end element pops
 * exactly that frame, so sibling elements never see each other's
 * declarations. Resolution follows "Namespaces in XML":
 *
 *  - an element with an empty prefix uses the current default namespace
 *    (`xmlns`), which can be cleared with `xmlns=""`;
 *  - an attribute with an empty prefix is always in no namespace;
 *  - the reserved prefixes `xml` and `xmlns` are fixed to their
 *    reserved URIs and cannot be (re)bound illegally.
 *
 * Events report the prefix, local name and resolved URI of every
 * element and attribute.
 */

export type QName = { prefix: string; local: string; uri: string };
export type XmlAttribute = QName & { value: string };

export type XmlEvent =
  | { type: 'startElement'; name: QName; attributes: XmlAttribute[] }
  | { type: 'endElement'; name: QName }
  | { type: 'text'; text: string };

export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const QNAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
const NCNAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function validateBinding(prefix: string, uri: string): void {
  if (prefix === 'xmlns') {
    throw new XmlError('the reserved prefix "xmlns" must not be declared');
  }
  if (prefix === 'xml' && uri !== XML_NAMESPACE) {
    throw new XmlError(`the reserved prefix "xml" must be bound to "${XML_NAMESPACE}"`);
  }
  if (prefix !== 'xml' && uri === XML_NAMESPACE) {
    throw new XmlError(`"${XML_NAMESPACE}" must not be bound to prefix "${prefix}"`);
  }
  if (uri === XMLNS_NAMESPACE) {
    throw new XmlError(`"${XMLNS_NAMESPACE}" must not be declared`);
  }
  if (prefix !== '' && uri === '') {
    throw new XmlError(`prefix "${prefix}" cannot be undeclared; only the default namespace can be cleared`);
  }
}

export class NamespaceStack {
  #frames: Array<Map<string, string>> = [new Map()];

  get depth(): number {
    return this.#frames.length;
  }

  /**
   * Push a scope frame for a start element. `declarations` maps prefixes
   * to URIs; the empty prefix is the default namespace, and binding it to
   * "" clears the default namespace inside this scope.
   */
  start(declarations: Record<string, string>): void {
    const frame = new Map(this.#frames[this.#frames.length - 1]);
    for (const [prefix, uri] of Object.entries(declarations)) {
      validateBinding(prefix, uri);
      if (uri === '') frame.delete(prefix);
      else frame.set(prefix, uri);
    }
    this.#frames.push(frame);
  }

  /** Pop the scope frame belonging to the matching end element. */
  end(): void {
    if (this.#frames.length === 1) {
      throw new XmlError('namespace stack underflow: end() without a matching start()');
    }
    this.#frames.pop();
  }

  /** Drop every open frame (error recovery between documents). */
  reset(): void {
    this.#frames = [new Map()];
  }

  /**
   * Resolve a qualified name to prefix, local name and namespace URI.
   * Pass `attribute = true` for attribute names: their empty prefix is
   * always in no namespace, unlike elements.
   */
  resolve(name: string, attribute = false): QName {
    const colon = name.indexOf(':');
    const prefix = colon === -1 ? '' : name.slice(0, colon);
    const local = colon === -1 ? name : name.slice(colon + 1);
    if (prefix === 'xml') return { prefix, local, uri: XML_NAMESPACE };
    if (prefix === 'xmlns') {
      if (attribute) return { prefix, local, uri: XMLNS_NAMESPACE };
      throw new XmlError('the reserved prefix "xmlns" cannot qualify an element name');
    }
    if (prefix === '') {
      const uri = attribute ? '' : (this.#frames[this.#frames.length - 1].get('') ?? '');
      return { prefix, local, uri };
    }
    const uri = this.#frames[this.#frames.length - 1].get(prefix);
    if (uri === undefined) throw new XmlError(`unbound namespace prefix "${prefix}"`);
    return { prefix, local, uri };
  }
}

const PREDEFINED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function toCodePoint(digits: string, base: number): string {
  const cp = parseInt(digits, base);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    throw new XmlError(`invalid character reference "&#${digits};"`);
  }
  return String.fromCodePoint(cp);
}

function decodeEntities(input: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const amp = input.indexOf('&', i);
    if (amp === -1) return out + input.slice(i);
    out += input.slice(i, amp);
    const semi = input.indexOf(';', amp + 1);
    const body = semi === -1 ? '' : input.slice(amp + 1, semi);
    if (!/^(?:#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z_:][A-Za-z0-9_.-]*)$/.test(body)) {
      throw new XmlError(`ill-formed entity reference at offset ${amp}`);
    }
    if (body.startsWith('#x') || body.startsWith('#X')) out += toCodePoint(body.slice(2), 16);
    else if (body.startsWith('#')) out += toCodePoint(body.slice(1), 10);
    else {
      const value = PREDEFINED_ENTITIES[body];
      if (value === undefined) throw new XmlError(`undefined entity "&${body};"`);
      out += value;
    }
    i = semi + 1;
  }
}

export class XmlStreamParser {
  #buffer = '';
  #ns = new NamespaceStack();
  #open: string[] = [];

  /** Number of currently open elements. */
  get depth(): number {
    return this.#open.length;
  }

  /** Discard all parser state so a fresh document can be parsed. */
  reset(): void {
    this.#buffer = '';
    this.#ns.reset();
    this.#open = [];
  }

  /**
   * Feed a chunk of the document and return the events completed by it.
   * Chunks may split the input at any byte boundary. On a parse error the
   * parser resets itself, so unclosed namespace frames never leak into
   * the next document.
   */
  write(chunk: string): XmlEvent[] {
    this.#buffer += chunk;
    try {
      return this.#drain(false);
    } catch (err) {
      this.reset();
      throw err;
    }
  }

  /** Signal end of input; throws if any element is still open. */
  end(): XmlEvent[] {
    try {
      const events = this.#drain(true);
      if (this.#open.length > 0) {
        throw new XmlError(`document ended with unclosed element <${this.#open[this.#open.length - 1]}>`);
      }
      return events;
    } catch (err) {
      this.reset();
      throw err;
    }
  }

  #drain(final: boolean): XmlEvent[] {
    const events: XmlEvent[] = [];
    for (;;) {
      if (this.#buffer.length === 0) break;
      if (this.#buffer[0] !== '<') {
        const next = this.#buffer.indexOf('<');
        if (next === -1) {
          // A "<" may still arrive in a later chunk; hold the text back.
          if (!final) break;
          events.push({ type: 'text', text: decodeEntities(this.#buffer) });
          this.#buffer = '';
          break;
        }
        events.push({ type: 'text', text: decodeEntities(this.#buffer.slice(0, next)) });
        this.#buffer = this.#buffer.slice(next);
        continue;
      }
      if (this.#buffer.startsWith('<!--')) {
        const close = this.#buffer.indexOf('-->', 4);
        if (close === -1) {
          this.#incomplete(final, 'comment');
          break;
        }
        this.#buffer = this.#buffer.slice(close + 3);
        continue;
      }
      if (this.#buffer.startsWith('<![CDATA[')) {
        const close = this.#buffer.indexOf(']]>', 9);
        if (close === -1) {
          this.#incomplete(final, 'CDATA section');
          break;
        }
        events.push({ type: 'text', text: this.#buffer.slice(9, close) });
        this.#buffer = this.#buffer.slice(close + 3);
        continue;
      }
      if (this.#buffer.startsWith('<?')) {
        const close = this.#buffer.indexOf('?>', 2);
        if (close === -1) {
          this.#incomplete(final, 'processing instruction');
          break;
        }
        this.#buffer = this.#buffer.slice(close + 2);
        continue;
      }
      if (this.#buffer.startsWith('<!')) {
        const close = this.#findDeclarationEnd(this.#buffer);
        if (close === -1) {
          this.#incomplete(final, 'markup declaration');
          break;
        }
        this.#buffer = this.#buffer.slice(close + 1);
        continue;
      }
      if (this.#buffer.startsWith('</')) {
        const close = this.#buffer.indexOf('>', 2);
        if (close === -1) {
          this.#incomplete(final, 'end tag');
          break;
        }
        events.push(this.#parseEndTag(this.#buffer.slice(2, close)));
        this.#buffer = this.#buffer.slice(close + 1);
        continue;
      }
      const close = this.#findTagEnd(this.#buffer);
      if (close === -1) {
        this.#incomplete(final, 'start tag');
        break;
      }
      events.push(...this.#parseStartTag(this.#buffer.slice(1, close)));
      this.#buffer = this.#buffer.slice(close + 1);
    }
    return events;
  }

  #incomplete(final: boolean, what: string): void {
    if (final) throw new XmlError(`unterminated ${what}`);
  }

  /** Index of the ">" closing a start tag, ignoring quoted sections. */
  #findTagEnd(s: string): number {
    let quote = '';
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (quote !== '') {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        return i;
      }
    }
    return -1;
  }

  /** Index of the ">" closing `<!...>`, skipping internal `[...]` subsets. */
  #findDeclarationEnd(s: string): number {
    let depth = 0;
    for (let i = 2; i < s.length; i++) {
      const c = s[i];
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '>' && depth === 0) return i;
    }
    return -1;
  }

  #parseStartTag(raw: string): XmlEvent[] {
    let body = raw;
    let empty = false;
    if (body.endsWith('/')) {
      empty = true;
      body = body.slice(0, -1);
    }
    let pos = 0;
    const skipWs = (): boolean => {
      const start = pos;
      while (pos < body.length && (body[pos] === ' ' || body[pos] === '\t' || body[pos] === '\n' || body[pos] === '\r')) pos++;
      return pos > start;
    };
    const readName = (): string => {
      const start = pos;
      if (pos < body.length && /[A-Za-z_]/.test(body[pos])) {
        pos++;
        while (pos < body.length && /[A-Za-z0-9_.:-]/.test(body[pos])) pos++;
      }
      return body.slice(start, pos);
    };

    const name = readName();
    this.#checkQName(name);

    const rawAttrs: Array<[string, string]> = [];
    const seenRaw = new Set<string>();
    for (;;) {
      const hadWs = skipWs();
      if (pos >= body.length) break;
      if (!hadWs) throw new XmlError(`expected whitespace before an attribute of <${name}>`);
      const attrName = readName();
      if (attrName === '') throw new XmlError(`expected an attribute name in <${name}>`);
      if (seenRaw.has(attrName)) throw new XmlError(`duplicate attribute "${attrName}"`);
      seenRaw.add(attrName);
      skipWs();
      if (body[pos] !== '=') throw new XmlError(`expected "=" after attribute "${attrName}"`);
      pos++;
      skipWs();
      const quote = body[pos];
      if (quote !== '"' && quote !== "'") throw new XmlError(`the value of attribute "${attrName}" must be quoted`);
      const close = body.indexOf(quote, pos + 1);
      if (close === -1) throw new XmlError(`unterminated value of attribute "${attrName}"`);
      const value = body.slice(pos + 1, close);
      if (value.includes('<')) throw new XmlError(`"<" is not allowed in the value of attribute "${attrName}"`);
      rawAttrs.push([attrName, decodeEntities(value)]);
      pos = close + 1;
    }

    // Split namespace declarations from ordinary attributes, in order.
    const declarations: Record<string, string> = {};
    const ordinary: Array<[string, string]> = [];
    for (const [attrName, value] of rawAttrs) {
      if (attrName === 'xmlns') {
        declarations[''] = value;
      } else if (attrName.startsWith('xmlns:')) {
        const prefix = attrName.slice(6);
        if (!NCNAME_RE.test(prefix)) throw new XmlError(`invalid namespace declaration "${attrName}"`);
        declarations[prefix] = value;
      } else {
        this.#checkQName(attrName);
        ordinary.push([attrName, value]);
      }
    }

    // One scope frame per element; popped by the matching end tag, or
    // immediately for an empty element.
    this.#ns.start(declarations);
    const qname = this.#ns.resolve(name);
    const seenExpanded = new Set<string>();
    const attributes: XmlAttribute[] = ordinary.map(([attrName, value]) => {
      const q = this.#ns.resolve(attrName, true);
      const key = `${q.uri}${q.local}`;
      if (seenExpanded.has(key)) {
        throw new XmlError(`attribute "${attrName}" expands to the same name as another attribute`);
      }
      seenExpanded.add(key);
      return { ...q, value };
    });

    const start: XmlEvent = { type: 'startElement', name: qname, attributes };
    if (empty) {
      this.#ns.end();
      return [start, { type: 'endElement', name: qname }];
    }
    this.#open.push(name);
    return [start];
  }

  #parseEndTag(raw: string): XmlEvent {
    const name = raw.trim();
    this.#checkQName(name);
    const expected = this.#open.pop();
    if (expected === undefined) throw new XmlError(`unexpected end tag </${name}>: no element is open`);
    if (expected !== name) throw new XmlError(`mismatched end tag </${name}>: expected </${expected}>`);
    // The end tag resolves in the scope of its own element, before that
    // element's namespace frame is popped.
    const qname = this.#ns.resolve(name);
    this.#ns.end();
    return { type: 'endElement', name: qname };
  }

  #checkQName(name: string): void {
    if (!QNAME_RE.test(name)) throw new XmlError(`invalid qualified name "${name}"`);
  }
}
