import { expect, it } from 'vitest';
import { NamespaceStack, XML_NS, XmlError, XmlStreamParser } from '../src/index.js';
import type { XmlEvent } from '../src/index.js';

function parse(parser: XmlStreamParser, doc: string, chunkSize = doc.length): XmlEvent[] {
  const events: XmlEvent[] = [];
  for (let i = 0; i < doc.length; i += chunkSize) {
    events.push(...parser.write(doc.slice(i, i + chunkSize)));
  }
  events.push(...parser.end());
  return events;
}

function startsOf(events: XmlEvent[]) {
  return events.filter((e) => e.type === 'start');
}

it('resolves a prefix', () => {
  const x = new NamespaceStack();
  x.start({ p: 'urn:p' });
  expect(x.resolve('p:x').uri).toBe('urn:p');
});

it('restores the parent scope after a nested default namespace closes', () => {
  const events = parse(
    new XmlStreamParser(),
    '<a xmlns="urn:a"><b xmlns="urn:b"><c/></b><d/></a>',
  );
  const uris = startsOf(events).map((e) => `${e.name.local}=${e.name.uri}`);
  expect(uris).toEqual(['a=urn:a', 'b=urn:b', 'c=urn:b', 'd=urn:a']);
});

it('puts empty-prefix attributes in no namespace even with a default namespace', () => {
  const events = parse(new XmlStreamParser(), '<a xmlns="urn:a" href="x" p:id="y" xmlns:p="urn:p"/>');
  const [start] = startsOf(events);
  expect(start.name.uri).toBe('urn:a');
  expect(start.attributes).toEqual([
    { prefix: '', local: 'href', uri: '', value: 'x' },
    { prefix: 'p', local: 'id', uri: 'urn:p', value: 'y' },
  ]);
});

it('supports clearing the default namespace with xmlns=""', () => {
  const events = parse(
    new XmlStreamParser(),
    '<a xmlns="urn:a"><b xmlns=""><c/></b><d/></a>',
  );
  const uris = startsOf(events).map((e) => e.name.uri);
  expect(uris).toEqual(['urn:a', '', '', 'urn:a']);
});

it('shadows a prefix in a nested scope and restores it afterwards', () => {
  const events = parse(
    new XmlStreamParser(),
    '<r xmlns:p="urn:outer"><p:a xmlns:p="urn:inner"><p:b/></p:a><p:c/></r>',
  );
  const uris = startsOf(events).map((e) => e.name.uri);
  expect(uris).toEqual(['', 'urn:inner', 'urn:inner', 'urn:outer']);
});

it('scopes an empty element’s declarations to itself only', () => {
  const events = parse(
    new XmlStreamParser(),
    '<r><x xmlns="urn:tmp" a="1"/><y/></r>',
  );
  const [, start, end, y] = events;
  expect(start).toMatchObject({ type: 'start', name: { local: 'x', uri: 'urn:tmp' } });
  expect(end).toMatchObject({ type: 'end', name: { local: 'x', uri: 'urn:tmp' } });
  expect(y).toMatchObject({ type: 'start', name: { local: 'y', uri: '' } });
});

it('applies multiple declarations from the same tag as one frame', () => {
  const events = parse(
    new XmlStreamParser(),
    '<a xmlns="urn:d" xmlns:p="urn:p" xmlns:q="urn:q"><p:x/><q:y/></a>',
  );
  const uris = startsOf(events).map((e) => e.name.uri);
  expect(uris).toEqual(['urn:d', 'urn:p', 'urn:q']);
});

it('rejects illegal rebinding of reserved prefixes and URIs', () => {
  const bad = [
    '<a xmlns:xml="urn:wrong"/>',
    '<a xmlns:xmlns="urn:x"/>',
    '<a xmlns:p="http://www.w3.org/2000/xmlns/"/>',
    '<a xmlns:p="http://www.w3.org/XML/1998/namespace"/>',
    '<a xmlns:xmlfoo="urn:x"/>',
    '<a xmlns:p=""/>',
  ];
  for (const doc of bad) {
    expect(() => parse(new XmlStreamParser(), doc), doc).toThrow(XmlError);
  }
  // Declaring xml to its canonical URI is legal.
  expect(() =>
    parse(new XmlStreamParser(), '<a xmlns:xml="http://www.w3.org/XML/1998/namespace"/>'),
  ).not.toThrow();
});

it('resolves the xml prefix without a declaration', () => {
  const events = parse(new XmlStreamParser(), '<a xml:lang="en"/>');
  const [start] = startsOf(events);
  expect(start.attributes[0]).toEqual({ prefix: 'xml', local: 'lang', uri: XML_NS, value: 'en' });
});

it('preserves attribute order', () => {
  const events = parse(
    new XmlStreamParser(),
    '<a z="1" p:m="2" xmlns:p="urn:p" a="3" p:n="4"/>',
  );
  const [start] = startsOf(events);
  expect(start.attributes.map((a) => a.local)).toEqual(['z', 'm', 'a', 'n']);
  expect(start.attributes.map((a) => a.value)).toEqual(['1', '2', '3', '4']);
});

it('rejects duplicate attributes after namespace expansion', () => {
  expect(() =>
    parse(new XmlStreamParser(), '<a xmlns:p="urn:s" xmlns:q="urn:s" p:x="1" q:x="2"/>'),
  ).toThrow(/Duplicate attribute/);
});

it('handles chunked input split anywhere, including inside tags and quotes', () => {
  const doc = '<r xmlns="urn:d" xmlns:p="urn:p"><p:a x="1>0"><b/></p:a><c/></r>';
  const whole = parse(new XmlStreamParser(), doc);
  for (const size of [1, 2, 3, 5, 7]) {
    expect(parse(new XmlStreamParser(), doc, size)).toEqual(whole);
  }
  const [r, pa, b, c] = startsOf(whole);
  expect(r.name.uri).toBe('urn:d');
  expect(pa.name).toEqual({ prefix: 'p', local: 'a', uri: 'urn:p' });
  expect(pa.attributes[0].value).toBe('1>0');
  expect(b.name.uri).toBe('urn:d');
  expect(c.name.uri).toBe('urn:d');
});

it('does not leak unclosed frames into the next document after an error', () => {
  const parser = new XmlStreamParser();
  parser.write('<a xmlns="urn:leaked"><b>');
  expect(() => parser.end()).toThrow(/not closed/);

  const events = parse(parser, '<c><d/></c>');
  const uris = startsOf(events).map((e) => e.name.uri);
  expect(uris).toEqual(['', '']);
});

it('recovers after a mismatched end tag', () => {
  const parser = new XmlStreamParser();
  expect(() => parser.write('<a xmlns="urn:x"></b>')).toThrow(/does not match/);
  const events = parse(parser, '<c/>');
  expect(startsOf(events)[0].name.uri).toBe('');
});

it('rejects unbound prefixes and malformed names', () => {
  expect(() => parse(new XmlStreamParser(), '<p:a/>')).toThrow(/Unbound prefix/);
  expect(() => parse(new XmlStreamParser(), '<a p:x="1"/>')).toThrow(/Unbound prefix/);
  expect(() => parse(new XmlStreamParser(), '<a:b:c/>')).toThrow(/Malformed qualified name/);
});

it('pops frames exactly once per element', () => {
  const stack = new NamespaceStack();
  stack.start({ p: 'urn:1' });
  stack.start({ p: 'urn:2' });
  expect(stack.resolve('p:x').uri).toBe('urn:2');
  stack.end();
  expect(stack.resolve('p:x').uri).toBe('urn:1');
  stack.end();
  expect(() => stack.resolve('p:x')).toThrow(/Unbound prefix/);
  expect(() => stack.end()).toThrow(/underflow/);
});
