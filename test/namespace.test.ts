import {describe, expect, it} from 'vitest';
import {SaxError, SaxParser, XMLNS_NS_URI, XML_NS_URI} from '../src/index.js';
import {assertSameEventsAcrossCuts, collectEvents, parseWhole} from './helpers.js';

function starts(events: ReturnType<typeof collectEvents>['events']) {
  return events.filter((e) => e.type === 'startElement');
}
function attrsOf(events: any[], local: string) {
  const e = events.find((x) => x.type === 'startElement' && x.local === local) as any;
  return Object.fromEntries(
    (e.attributes as any[]).map((a) => [
      a.uri === '' ? a.local : `{${a.uri}}${a.local}`,
      a.value,
    ]),
  );
}

describe('namespace resolution', () => {
  it('puts elements in the default namespace and unprefixed attrs in none', () => {
    const doc = '<r xmlns="urn:d"><c a="1" b="2"/></r>';
    const ev = parseWhole(doc);
    const r = starts(ev)[0] as any;
    expect([r.prefix, r.local, r.uri]).toEqual(['', 'r', 'urn:d']);
    const c = starts(ev)[1] as any;
    expect(c.uri).toBe('urn:d');
    // Unprefublished attributes are in NO namespace even with a default ns.
    for (const a of c.attributes as any[]) {
      expect(a.uri).toBe('');
      expect(a.prefix).toBe('');
    }
    expect(attrsOf(ev, 'c')).toEqual({a: '1', b: '2'});
  });

  it('redeclares, clears and restores default namespace by scope', () => {
    const doc =
      '<a xmlns="urn:outer">' +
      '<b xmlns="urn:inner"><c/></b>' +
      '<d xmlns=""><e/></d>' +
      '<f/>' +
      '</a>';
    const ev = parseWhole(doc);
    const uri = (local: string) => (starts(ev).find((x: any) => x.local === local) as any).uri;
    expect(uri('a')).toBe('urn:outer');
    expect(uri('b')).toBe('urn:inner');
    expect(uri('c')).toBe('urn:inner');
    // xmlns="" clears the default for d and e...
    expect(uri('d')).toBe('');
    expect(uri('e')).toBe('');
    // ...and the sibling f is back in the outer binding.
    expect(uri('f')).toBe('urn:outer');
  });

  it('resolves prefixed elements and attributes, and keeps sibling scopes independent', () => {
    const doc =
      '<a xmlns:p="urn:p" xmlns:q="urn:q">' +
      '<p:b p:x="1" q:y="2" z="3"/>' +
      '<q:c/>' +
      '</a>';
    const ev = parseWhole(doc);
    const b = starts(ev).find((x: any) => x.local === 'b') as any;
    expect([b.prefix, b.local, b.uri]).toEqual(['p', 'b', 'urn:p']);
    const attrKeys = (b.attributes as any[]).map((a) => [a.prefix, a.local, a.uri]);
    expect(attrKeys).toEqual([
      ['p', 'x', 'urn:p'],
      ['q', 'y', 'urn:q'],
      ['', 'z', ''],
    ]);
    const c = starts(ev).find((x: any) => x.local === 'c') as any;
    expect(c.uri).toBe('urn:q');
  });

  it('shadowing an outer prefix inside an element and restoring after', () => {
    const doc =
      '<a xmlns:p="urn:one"><p:b/><g xmlns:p="urn:two"><p:h/></g><p:i/></a>';
    const ev = parseWhole(doc);
    const get = (local: string) =>
      (starts(ev).find((x: any) => x.local === local) as any).uri;
    expect(get('b')).toBe('urn:one');
    expect(get('h')).toBe('urn:two');
    expect(get('i')).toBe('urn:one');
  });

  it('resolves the built-in xml prefix without a declaration', () => {
    const doc = '<r xml:lang="en" xml:space="preserve"/>';
    const ev = parseWhole(doc);
    const r = starts(ev)[0] as any;
    const langs = (r.attributes as any[]).filter((a) => a.local === 'lang');
    expect(langs[0].prefix).toBe('xml');
    expect(langs[0].uri).toBe(XML_NS_URI);
    const spaces = (r.attributes as any[]).filter((a) => a.local === 'space');
    expect(spaces[0].uri).toBe(XML_NS_URI);
  });

  it('reports end elements with the same resolved name as the start', () => {
    const doc = '<a xmlns:p="urn:p"><p:b>x</p:b></a>';
    const ev = parseWhole(doc);
    const endB = ev.find((e) => e.type === 'endElement' && e.local === 'b') as any;
    expect([endB.prefix, endB.local, endB.uri]).toEqual(['p', 'b', 'urn:p']);
  });

  it('yields identical namespace results under every cut plan', () => {
    const doc =
      '<a xmlns="urn:o" xmlns:p="urn:p">' +
      '<b xmlns="urn:i" p:k="v"/>' +
      '<c xmlns=""><d/></c>' +
      '<p:e p:f="g"/>' +
      '</a>';
    assertSameEventsAcrossCuts(doc);
  });
});

describe('namespace well-formedness errors', () => {
  const shouldFail = (doc: string, messagePart?: string) => {
    const {handlers} = collectEvents();
    const p = new SaxParser({handlers});
    let caught: unknown;
    try {
      p.write(Buffer.from(doc));
      p.close();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SaxError);
    if (messagePart && caught) expect((caught as Error).message).toContain(messagePart);
  };

  it('rejects an unbound element prefix', () => {
    shouldFail('<p:a/>', 'unbound namespace prefix');
  });

  it('rejects an unbound attribute prefix', () => {
    shouldFail('<a xmlns:p="urn:p"><b q:x="1"/></a>', 'unbound namespace prefix');
  });

  it('rejects an unbound prefix in an end tag', () => {
    shouldFail('<a xmlns:p="urn:p"><b></q:b></a>', 'unbound namespace prefix');
  });

  it('rejects binding the xml prefix to another URI', () => {
    shouldFail('<a xmlns:xml="urn:not-xml"/>', 'xml');
  });

  it('rejects binding another prefix to the xml namespace URI', () => {
    shouldFail(`<a xmlns:foo="${XML_NS_URI}"/>`, XML_NS_URI);
  });

  it('rejects declaring the xmlns prefix', () => {
    shouldFail('<a xmlns:xmlns="urn:x"/>');
  });

  it('rejects binding the reserved xmlns namespace URI as default', () => {
    shouldFail(`<a xmlns="${XMLNS_NS_URI}"/>`);
  });

  it('rejects undeclaring a prefixed namespace (XML 1.0)', () => {
    shouldFail('<a xmlns:p="urn:p"><b xmlns:p=""/></a>');
  });

  it('detects duplicate attributes via different prefixes with same URI+local', () => {
    shouldFail(
      '<a xmlns:p="urn:x" xmlns:q="urn:x" p:k="1" q:k="2"/>',
      'duplicate attribute',
    );
  });

  it('does NOT treat an unprefixed attr and a prefix-to-default-URI attr as duplicates', () => {
    // The unprefixed attribute has no namespace even though the element is in
    // a default namespace, so it cannot collide with a prefixed one.
    const doc = '<a xmlns="urn:x" xmlns:p="urn:x" x="1" p:x="2"/>';
    const ev = parseWhole(doc);
    const a = starts(ev)[0] as any;
    expect(a.attributes).toHaveLength(2);
    expect(a.attributes[0].uri).toBe('');
    expect(a.attributes[1].uri).toBe('urn:x');
  });

  it('does NOT treat same-local attrs in different namespaces as duplicates', () => {
    const doc = '<a xmlns:p="urn:x" xmlns:q="urn:y" p:k="1" q:k="2" k="3"/>';
    const ev = parseWhole(doc);
    const a = starts(ev)[0] as any;
    expect(a.attributes).toHaveLength(3);
  });

  it('rejects a duplicated namespace declaration for the same prefix', () => {
    shouldFail('<a xmlns:p="urn:x" xmlns:p="urn:y"/>', 'duplicate namespace');
  });

  it('does not expose xmlns declarations as attributes', () => {
    const ev = parseWhole('<a xmlns="urn:o" xmlns:p="urn:p" x="1"/>');
    const a = starts(ev)[0] as any;
    expect(a.attributes).toHaveLength(1);
    expect(a.attributes[0].local).toBe('x');
  });
});
