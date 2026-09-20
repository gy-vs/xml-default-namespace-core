import { describe, expect, it } from 'vitest';
import {
  NamespaceStack,
  XML_NAMESPACE,
  XMLNS_NAMESPACE,
  XmlError,
  XmlStreamParser,
  type XmlEvent,
} from '../src/index.js';

function parse(doc: string): XmlEvent[] {
  const p = new XmlStreamParser();
  const events = p.write(doc);
  events.push(...p.end());
  return events;
}

function parseChunked(doc: string, size: number): XmlEvent[] {
  const p = new XmlStreamParser();
  const events: XmlEvent[] = [];
  for (let i = 0; i < doc.length; i += size) events.push(...p.write(doc.slice(i, i + size)));
  events.push(...p.end());
  return events;
}

/** start/end events only, as [type, prefix, local, uri] tuples. */
function tags(events: XmlEvent[]): Array<[string, string, string, string]> {
  return events
    .filter((e): e is Extract<XmlEvent, { type: 'startElement' | 'endElement' }> => e.type !== 'text')
    .map((e) => [e.type, e.name.prefix, e.name.local, e.name.uri]);
}

describe('NamespaceStack', () => {
  it('resolves a prefix', () => {
    const x = new NamespaceStack();
    x.start({ p: 'urn:p' });
    expect(x.resolve('p:x').uri).toBe('urn:p');
  });

  it('restores the parent scope exactly when a child frame is popped', () => {
    const ns = new NamespaceStack();
    ns.start({ '': 'urn:outer', a: 'urn:a' });
    ns.start({ '': 'urn:inner', b: 'urn:b' });
    expect(ns.resolve('x').uri).toBe('urn:inner');
    ns.end();
    expect(ns.resolve('x').uri).toBe('urn:outer');
    expect(ns.resolve('a:x').uri).toBe('urn:a');
    expect(() => ns.resolve('b:x')).toThrow(XmlError);
    ns.end();
    expect(ns.resolve('x').uri).toBe('');
  });

  it('clears the default namespace with xmlns=""', () => {
    const ns = new NamespaceStack();
    ns.start({ '': 'urn:d' });
    ns.start({ '': '' });
    expect(ns.resolve('x').uri).toBe('');
    ns.end();
    expect(ns.resolve('x').uri).toBe('urn:d');
  });

  it('puts empty-prefix attributes in no namespace, elements in the default namespace', () => {
    const ns = new NamespaceStack();
    ns.start({ '': 'urn:d' });
    expect(ns.resolve('x')).toEqual({ prefix: '', local: 'x', uri: 'urn:d' });
    expect(ns.resolve('x', true)).toEqual({ prefix: '', local: 'x', uri: '' });
  });

  it('follows the reserved prefix rules', () => {
    const ns = new NamespaceStack();
    expect(ns.resolve('xml:lang').uri).toBe(XML_NAMESPACE);
    expect(ns.resolve('xml:lang', true).uri).toBe(XML_NAMESPACE);
    expect(ns.resolve('xmlns:p', true).uri).toBe(XMLNS_NAMESPACE);
    expect(() => ns.resolve('xmlns:p')).toThrow(/xmlns/);
    expect(() => ns.start({ xml: 'urn:wrong' })).toThrow(/xml/);
    expect(() => ns.start({ xmlns: 'urn:x' })).toThrow(/xmlns/);
    expect(() => ns.start({ p: XML_NAMESPACE })).toThrow(/must not be bound/);
    expect(() => ns.start({ p: XMLNS_NAMESPACE })).toThrow(/xmlns/);
    expect(() => ns.start({ p: '' })).toThrow(/undeclared/);
    expect(() => ns.start({ xml: XML_NAMESPACE })).not.toThrow();
  });

  it('rejects unbound prefixes and underflow', () => {
    const ns = new NamespaceStack();
    expect(() => ns.resolve('p:x')).toThrow(/unbound/);
    expect(() => ns.end()).toThrow(/underflow/);
  });
});

describe('XmlStreamParser scoping', () => {
  it('restores the parent namespace scope when a child element closes', () => {
    const events = parse(
      '<root xmlns="urn:outer"><child xmlns="urn:inner"><leaf/></child><sibling/></root>',
    );
    expect(tags(events)).toEqual([
      ['startElement', '', 'root', 'urn:outer'],
      ['startElement', '', 'child', 'urn:inner'],
      ['startElement', '', 'leaf', 'urn:inner'],
      ['endElement', '', 'leaf', 'urn:inner'],
      ['endElement', '', 'child', 'urn:inner'],
      ['startElement', '', 'sibling', 'urn:outer'],
      ['endElement', '', 'sibling', 'urn:outer'],
      ['endElement', '', 'root', 'urn:outer'],
    ]);
  });

  it('clears the default namespace with xmlns="" and restores it afterwards', () => {
    const events = parse('<a xmlns="urn:x"><b xmlns=""><c/></b><d/></a>');
    expect(tags(events)).toEqual([
      ['startElement', '', 'a', 'urn:x'],
      ['startElement', '', 'b', ''],
      ['startElement', '', 'c', ''],
      ['endElement', '', 'c', ''],
      ['endElement', '', 'b', ''],
      ['startElement', '', 'd', 'urn:x'],
      ['endElement', '', 'd', 'urn:x'],
      ['endElement', '', 'a', 'urn:x'],
    ]);
  });

  it('supports prefix shadowing in nested scopes', () => {
    const events = parse('<a xmlns:p="urn:outer"><b xmlns:p="urn:inner"><p:c/></b><p:d/></a>');
    expect(tags(events)).toEqual([
      ['startElement', '', 'a', ''],
      ['startElement', '', 'b', ''],
      ['startElement', 'p', 'c', 'urn:inner'],
      ['endElement', 'p', 'c', 'urn:inner'],
      ['endElement', '', 'b', ''],
      ['startElement', 'p', 'd', 'urn:outer'],
      ['endElement', 'p', 'd', 'urn:outer'],
      ['endElement', '', 'a', ''],
    ]);
  });

  it('scopes empty elements and pops their frame immediately', () => {
    const events = parse('<a xmlns="urn:x"><b xmlns="urn:y"/><c/></a>');
    expect(tags(events)).toEqual([
      ['startElement', '', 'a', 'urn:x'],
      ['startElement', '', 'b', 'urn:y'],
      ['endElement', '', 'b', 'urn:y'],
      ['startElement', '', 'c', 'urn:x'],
      ['endElement', '', 'c', 'urn:x'],
      ['endElement', '', 'a', 'urn:x'],
    ]);
    expect(tags(parse('<only xmlns="urn:one"/>'))).toEqual([
      ['startElement', '', 'only', 'urn:one'],
      ['endElement', '', 'only', 'urn:one'],
    ]);
  });

  it('applies multiple declarations on the same tag to that element and its children', () => {
    const events = parse('<a xmlns="urn:d" xmlns:p="urn:p" xmlns:q="urn:q"><p:b/><q:c/></a>');
    expect(tags(events)).toEqual([
      ['startElement', '', 'a', 'urn:d'],
      ['startElement', 'p', 'b', 'urn:p'],
      ['endElement', 'p', 'b', 'urn:p'],
      ['startElement', 'q', 'c', 'urn:q'],
      ['endElement', 'q', 'c', 'urn:q'],
      ['endElement', '', 'a', 'urn:d'],
    ]);
  });

  it('rejects illegal rebinding of reserved prefixes and URIs', () => {
    for (const doc of [
      '<a xmlns:xml="urn:wrong"/>',
      '<a xmlns:xmlns="urn:x"/>',
      `<a xmlns:p="${XML_NAMESPACE}"/>`,
      `<a xmlns:p="${XMLNS_NAMESPACE}"/>`,
      '<a xmlns:p=""/>',
      '<p:a/>',
      '<a p:b="1"/>',
    ]) {
      const p = new XmlStreamParser();
      expect(() => p.write(doc), doc).toThrow(XmlError);
    }
  });

  it('accepts binding the xml prefix to its reserved URI', () => {
    const events = parse(`<a xmlns:xml="${XML_NAMESPACE}"><xml:b/></a>`);
    expect(tags(events)).toEqual([
      ['startElement', '', 'a', ''],
      ['startElement', 'xml', 'b', XML_NAMESPACE],
      ['endElement', 'xml', 'b', XML_NAMESPACE],
      ['endElement', '', 'a', ''],
    ]);
  });
});

describe('XmlStreamParser attributes', () => {
  it('keeps empty-prefix attributes in no namespace and resolves prefixed ones', () => {
    const [start] = parse('<a xmlns="urn:d" xmlns:p="urn:p" x="1" p:y="2" xml:lang="en"/>');
    if (start.type !== 'startElement') throw new Error('expected startElement');
    expect(start.name).toEqual({ prefix: '', local: 'a', uri: 'urn:d' });
    expect(start.attributes).toEqual([
      { prefix: '', local: 'x', uri: '', value: '1' },
      { prefix: 'p', local: 'y', uri: 'urn:p', value: '2' },
      { prefix: 'xml', local: 'lang', uri: XML_NAMESPACE, value: 'en' },
    ]);
  });

  it('preserves document order of attributes and omits xmlns declarations', () => {
    const [start] = parse(`<a z="1" xmlns:p="urn:p" p:m="2" xmlns="urn:d" a="3"/>`);
    if (start.type !== 'startElement') throw new Error('expected startElement');
    expect(start.attributes.map((a) => [a.prefix, a.local, a.uri, a.value])).toEqual([
      ['', 'z', '', '1'],
      ['p', 'm', 'urn:p', '2'],
      ['', 'a', '', '3'],
    ]);
  });

  it('rejects duplicate attributes, including duplicates after expansion', () => {
    expect(() => parse('<a x="1" x="2"/>')).toThrow(/duplicate/);
    expect(() => parse('<a xmlns:p="urn:x" xmlns:q="urn:x" p:n="1" q:n="2"/>')).toThrow(/same name/);
  });
});

describe('XmlStreamParser streaming', () => {
  const doc =
    '<?xml version="1.0"?><!-- c --><root xmlns="urn:o" xmlns:p="urn:p">' +
    '<item p:id="1">text &amp; &#65;<![CDATA[<raw>]]></item><empty/></root>';

  it('produces identical events for chunked input, down to one character per write', () => {
    const whole = parse(doc);
    for (const size of [1, 2, 3, 7, 64]) {
      expect(parseChunked(doc, size)).toEqual(whole);
    }
  });

  it('emits text with decoded entities and CDATA content', () => {
    const texts = parse(doc)
      .filter((e): e is Extract<XmlEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.text);
    expect(texts).toEqual(['text & A', '<raw>']);
  });

  it('waits for a tag split across chunks before emitting events', () => {
    const p = new XmlStreamParser();
    expect(p.write('<a xmlns="ur')).toEqual([]);
    // This chunk completes the start tag of <a>, so only its event is ready.
    expect(tags(p.write('n:x"><b'))).toEqual([['startElement', '', 'a', 'urn:x']]);
    const events = p.write('/></a>');
    expect(tags(events)).toEqual([
      ['startElement', '', 'b', 'urn:x'],
      ['endElement', '', 'b', 'urn:x'],
      ['endElement', '', 'a', 'urn:x'],
    ]);
  });
});

describe('XmlStreamParser error recovery', () => {
  it('does not carry unclosed frames into the next document after a mismatch error', () => {
    const p = new XmlStreamParser();
    expect(() => p.write('<a xmlns="urn:leak"><b></a>')).toThrow(/mismatched/);
    expect(p.depth).toBe(0);
    const events = [...p.write('<x xmlns="urn:fresh"><y/></x>'), ...p.end()];
    expect(tags(events)).toEqual([
      ['startElement', '', 'x', 'urn:fresh'],
      ['startElement', '', 'y', 'urn:fresh'],
      ['endElement', '', 'y', 'urn:fresh'],
      ['endElement', '', 'x', 'urn:fresh'],
    ]);
  });

  it('resets after end() rejects unclosed elements', () => {
    const p = new XmlStreamParser();
    p.write('<a xmlns="urn:leak"><b>');
    expect(() => p.end()).toThrow(/unclosed/);
    expect(p.depth).toBe(0);
    // A leaked frame would resolve <y/> into urn:leak.
    const events = [...p.write('<x><y/></x>'), ...p.end()];
    expect(tags(events)).toEqual([
      ['startElement', '', 'x', ''],
      ['startElement', '', 'y', ''],
      ['endElement', '', 'y', ''],
      ['endElement', '', 'x', ''],
    ]);
  });

  it('resets after a namespace error mid-document', () => {
    const p = new XmlStreamParser();
    expect(() => p.write('<a xmlns="urn:leak"><p:b/></a>')).toThrow(/unbound/);
    const events = [...p.write('<ok/>'), ...p.end()];
    expect(tags(events)).toEqual([
      ['startElement', '', 'ok', ''],
      ['endElement', '', 'ok', ''],
    ]);
  });

  it('can be reused for a second document after a clean end()', () => {
    const p = new XmlStreamParser();
    p.write('<a xmlns="urn:one"/>');
    p.end();
    const events = [...p.write('<b xmlns="urn:two"/>'), ...p.end()];
    expect(tags(events)).toEqual([
      ['startElement', '', 'b', 'urn:two'],
      ['endElement', '', 'b', 'urn:two'],
    ]);
  });

  it('rejects malformed input', () => {
    for (const doc of [
      '<a></b>',
      '</a>',
      '<a><b></b>',
      '<a x=1/>',
      '<a x="1"y="2"/>',
      '< a/>',
      '<a>&undefined;</a>',
      '<a>text',
    ]) {
      const p = new XmlStreamParser();
      expect(() => {
        p.write(doc);
        p.end();
      }, doc).toThrow(XmlError);
    }
  });
});
