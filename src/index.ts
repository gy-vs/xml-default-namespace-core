export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

export type QName = { prefix: string; local: string; uri: string };

export type XmlAttribute = QName & { value: string };

export type XmlEvent =
  | { type: 'start'; name: QName; attributes: XmlAttribute[] }
  | { type: 'end'; name: QName };

function splitName(raw: string): { prefix: string; local: string } {
  const parts = raw.split(':');
  if (parts.length > 2 || parts.some((p) => p === '')) {
    throw new XmlError(`Malformed qualified name: "${raw}"`);
  }
  return parts.length === 2
    ? { prefix: parts[0], local: parts[1] }
    : { prefix: '', local: parts[0] };
}

function validateDeclarations(declarations: Record<string, string>): void {
  for (const [prefix, uri] of Object.entries(declarations)) {
    if (prefix === 'xmlns') {
      throw new XmlError('The "xmlns" prefix must not be declared');
    }
    if (prefix === 'xml') {
      if (uri !== XML_NS) {
        throw new XmlError(`The "xml" prefix must be bound to ${XML_NS}`);
      }
      continue;
    }
    if (/^xml/i.test(prefix)) {
      throw new XmlError(`Prefix "${prefix}" is reserved`);
    }
    if (uri === XMLNS_NS) {
      throw new XmlError(`Prefix "${prefix}" must not be bound to ${XMLNS_NS}`);
    }
    if (uri === XML_NS) {
      throw new XmlError(`Prefix "${prefix}" must not be bound to ${XML_NS}`);
    }
    if (prefix !== '' && uri === '') {
      throw new XmlError(`Prefix "${prefix}" cannot be undeclared`);
    }
  }
}

/**
 * One frame per start element, holding only that element's own declarations.
 * Lookup walks outward, so popping the frame on the matching end element
 * restores the parent scope exactly.
 */
export class NamespaceStack {
  #frames: Record<string, string>[] = [{}];

  get depth(): number {
    return this.#frames.length;
  }

  start(declarations: Record<string, string>): void {
    validateDeclarations(declarations);
    this.#frames.push(declarations);
  }

  end(): void {
    if (this.#frames.length <= 1) {
      throw new XmlError('Namespace stack underflow');
    }
    this.#frames.pop();
  }

  reset(): void {
    this.#frames = [{}];
  }

  lookup(prefix: string): string | undefined {
    for (let i = this.#frames.length - 1; i >= 0; i--) {
      if (Object.hasOwn(this.#frames[i], prefix)) return this.#frames[i][prefix];
    }
    return undefined;
  }

  resolve(name: string, attribute = false): QName {
    const { prefix, local } = splitName(name);
    if (prefix === 'xmlns') {
      throw new XmlError('The "xmlns" prefix cannot be used for an element or attribute');
    }
    if (prefix === 'xml') {
      return { prefix, local, uri: XML_NS };
    }
    if (prefix === '') {
      // Empty prefix on an attribute is always in no namespace; on an
      // element it uses the current default namespace (possibly cleared
      // to "" by xmlns="").
      return { prefix, local, uri: attribute ? '' : (this.lookup('') ?? '') };
    }
    const uri = this.lookup(prefix);
    if (uri === undefined) {
      throw new XmlError(`Unbound prefix: "${prefix}"`);
    }
    return { prefix, local, uri };
  }
}

type OpenElement = { raw: string; name: QName };

export class XmlStreamParser {
  #buffer = '';
  #stack = new NamespaceStack();
  #open: OpenElement[] = [];

  /** Feed a chunk of XML. Returns the events completed by this chunk. */
  write(chunk: string): XmlEvent[] {
    this.#buffer += chunk;
    const events: XmlEvent[] = [];
    try {
      this.#drain(events);
    } catch (error) {
      this.reset();
      throw error;
    }
    return events;
  }

  /** Signal end of input. Throws if the document is incomplete. */
  end(): XmlEvent[] {
    try {
      if (this.#buffer.trim() !== '') {
        throw new XmlError('Unexpected end of input: incomplete token');
      }
      if (this.#open.length > 0) {
        throw new XmlError(`Unexpected end of input: <${this.#open.at(-1)!.raw}> is not closed`);
      }
    } catch (error) {
      this.reset();
      throw error;
    }
    return [];
  }

  /** Drop all parser state so a fresh document can be parsed. */
  reset(): void {
    this.#buffer = '';
    this.#stack.reset();
    this.#open = [];
  }

  #drain(events: XmlEvent[]): void {
    for (;;) {
      const lt = this.#buffer.indexOf('<');
      if (lt < 0) {
        this.#buffer = ''; // character data is not reported
        return;
      }
      if (lt > 0) {
        this.#buffer = this.#buffer.slice(lt);
        continue;
      }
      const rest = this.#buffer;
      if (rest.startsWith('<!--')) {
        const close = rest.indexOf('-->', 4);
        if (close < 0) return;
        this.#buffer = rest.slice(close + 3);
      } else if (rest.startsWith('<![CDATA[')) {
        const close = rest.indexOf(']]>', 9);
        if (close < 0) return;
        this.#buffer = rest.slice(close + 3);
      } else if (rest.startsWith('<?')) {
        const close = rest.indexOf('?>', 2);
        if (close < 0) return;
        this.#buffer = rest.slice(close + 2);
      } else if (rest.startsWith('<!')) {
        const close = rest.indexOf('>', 2);
        if (close < 0) return;
        this.#buffer = rest.slice(close + 1);
      } else if (rest.startsWith('</')) {
        const close = rest.indexOf('>', 2);
        if (close < 0) return;
        this.#endTag(rest.slice(2, close).trim(), events);
        this.#buffer = rest.slice(close + 1);
      } else {
        const close = this.#findTagEnd(rest);
        if (close < 0) return;
        this.#startTag(rest.slice(1, close), events);
        this.#buffer = rest.slice(close + 1);
      }
    }
  }

  /** Index of the '>' closing a start tag, honoring quoted values. */
  #findTagEnd(text: string): number {
    let quote: string | undefined;
    for (let i = 1; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        return i;
      }
    }
    return -1;
  }

  #startTag(body: string, events: XmlEvent[]): void {
    const match = /^([^\s/>]+)/.exec(body);
    if (!match) throw new XmlError('Expected an element name');
    const raw = match[1];
    let rest = body.slice(raw.length);

    const declarations: Record<string, string> = {};
    const attributes: { raw: string; value: string }[] = [];
    let empty = false;
    for (;;) {
      rest = rest.replace(/^\s+/, '');
      // The caller already consumed the closing '>'.
      if (rest.startsWith('/')) {
        empty = true;
        rest = rest.slice(1);
        break;
      }
      if (rest === '') break;
      const attr = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(rest);
      if (!attr) throw new XmlError(`Malformed attribute in <${raw}>`);
      const name = attr[1];
      const value = attr[3] ?? attr[4] ?? '';
      if (name === 'xmlns') {
        if (Object.hasOwn(declarations, '')) throw new XmlError('Duplicate default namespace declaration');
        declarations[''] = value;
      } else if (name.startsWith('xmlns:')) {
        const prefix = name.slice(6);
        if (prefix === '' || prefix.includes(':')) throw new XmlError(`Malformed namespace declaration: "${name}"`);
        if (Object.hasOwn(declarations, prefix)) throw new XmlError(`Duplicate namespace declaration for "${prefix}"`);
        declarations[prefix] = value;
      } else {
        attributes.push({ raw: name, value });
      }
      rest = rest.slice(attr[0].length);
    }
    if (rest.trim() !== '') throw new XmlError(`Unexpected content in <${raw}>`);

    this.#stack.start(declarations);
    try {
      const name = this.#stack.resolve(raw);
      const seen = new Set<string>();
      const resolved = attributes.map(({ raw: attrRaw, value }) => {
        const qname = this.#stack.resolve(attrRaw, true);
        const key = `${qname.uri}${qname.local}`;
        if (seen.has(key)) throw new XmlError(`Duplicate attribute: "${attrRaw}"`);
        seen.add(key);
        return { ...qname, value };
      });
      events.push({ type: 'start', name, attributes: resolved });
      if (empty) {
        events.push({ type: 'end', name });
        this.#stack.end();
      } else {
        this.#open.push({ raw, name });
      }
    } catch (error) {
      this.#stack.end();
      throw error;
    }
  }

  #endTag(raw: string, events: XmlEvent[]): void {
    if (raw === '') throw new XmlError('Empty end tag');
    const open = this.#open.pop();
    if (!open || open.raw !== raw) {
      throw new XmlError(`End tag </${raw}> does not match ${open ? `<${open.raw}>` : 'any open element'}`);
    }
    events.push({ type: 'end', name: open.name });
    this.#stack.end();
  }
}
