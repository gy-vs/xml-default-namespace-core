import {describe, expect, it} from 'vitest';
import {Buffer} from 'node:buffer';
import {SaxError, SaxParser} from '../src/index.js';
import {parseChopped} from './helpers.js';

describe('exhaustive boundary cuts', () => {
  const docs = [
    '<r><![CDATA[payload]]></r>',
    '<r><!-- comment --></r>',
    '<?pi data?><r/>',
    '<r a="v"/>',
    '<r>text&amp;more</r>',
    '<r xmlns:p="urn:p"><p:x p:y="z"/></r>',
    '<r>中</r>',
    '<r>a😀b</r>',
    '<r>line1\r\nline2\rend</r>',
  ];

  for (const doc of docs) {
    it(`cut at every single byte offset: ${JSON.stringify(doc).slice(0, 40)}`, () => {
      const bytes = Buffer.from(doc);
      // Baseline must use the SAME textChunkSize as the split parsers, since
      // chunk size fixes the text-event boundaries.
      const make = () => {
        const ev: any[] = [];
        return {
          events: ev,
          handlers: {
            startDocument: () => ev.push({type: 'startDocument'}),
            endDocument: () => ev.push({type: 'endDocument'}),
            startElement: (n: any, a: any) =>
              ev.push({
                type: 'startElement',
                prefix: n.prefix,
                local: n.local,
                uri: n.uri,
                attributes: a.map((x: any) => ({
                  prefix: x.name.prefix,
                  local: x.name.local,
                  uri: x.name.uri,
                  value: x.value,
                })),
              }),
            endElement: (n: any) =>
              ev.push({type: 'endElement', prefix: n.prefix, local: n.local, uri: n.uri}),
            text: (t: string) => ev.push({type: 'text', text: t}),
            cdata: (t: string) => ev.push({type: 'cdata', text: t}),
            comment: (t: string) => ev.push({type: 'comment', text: t}),
            processingInstruction: (t: string, d: string) =>
              ev.push({type: 'processingInstruction', target: t, data: d}),
          },
        };
      };
      const base = make();
      new SaxParser({handlers: base.handlers, textChunkSize: 7}).write(bytes).close();
      const baseline = base.events;

      // For every offset, split into exactly two pieces at that byte boundary.
      for (let cut = 1; cut < bytes.length; cut++) {
        const made = make();
        const p = new SaxParser({handlers: made.handlers, textChunkSize: 7});
        p.write(bytes.subarray(0, cut));
        p.write(bytes.subarray(cut));
        p.close();
        expect(made.events, `mismatch when split at byte ${cut}`).toEqual(baseline);
      }
    });
  }
});

describe('API surface', () => {
  it('accepts string chunks directly', () => {
    const ev = parseChopped('<r>hi&amp;</r>', [2]);
    const text = ev.filter((e) => e.type === 'text').map((e) => e.text).join('');
    expect(text).toBe('hi&');
  });

  it('on() registers handlers and is chainable', () => {
    const p = new SaxParser();
    const ret = p
      .on('startElement', () => {})
      .on('endElement', () => {});
    expect(ret).toBe(p);
    p.write('<r/>');
    p.close();
  });

  it('emits startDocument on first write and endDocument on close', () => {
    const order: string[] = [];
    const p = new SaxParser({
      handlers: {
        startDocument: () => order.push('startDocument'),
        endDocument: () => order.push('endDocument'),
      },
    });
    p.write('<r>');
    p.write('</r>');
    p.close();
    expect(order).toEqual(['startDocument', 'endDocument']);
  });

  it('emits startDocument even for an empty-then-close document only when content exists', () => {
    const order: string[] = [];
    const p = new SaxParser({
      handlers: {
        startDocument: () => order.push('startDocument'),
        endDocument: () => order.push('endDocument'),
      },
    });
    expect(() => p.close()).toThrow(SaxError); // no root
  });

  it('line/column counts columns past multibyte characters as one column each', () => {
    // 中 is one character column; <p:b/> begins at column 5.
    const doc = '<r>中<p:b/></r>';
    let err: SaxError | undefined;
    const p = new SaxParser();
    try {
      p.write(Buffer.from(doc));
      p.close();
    } catch (e) {
      if (e instanceof SaxError) err = e;
    }
    // p is bound? no -> unbound prefix error
    expect(err).toBeInstanceOf(SaxError);
    expect(err!.line).toBe(1);
    expect(err!.column).toBe(5);
  });

  it('rejects writing to an errored parser until reset', () => {
    const p = new SaxParser();
    expect(() => {
      p.write('<r><unclosed');
      p.close();
    }).toThrow(SaxError);
    expect(() => p.write('<a/>')).toThrow(SaxError);
    p.reset();
    expect(() => {
      p.write('<a/>');
      p.close();
    }).not.toThrow();
  });

  it('rejects a second close()', () => {
    const p = new SaxParser();
    p.write('<r/>');
    p.close();
    expect(() => p.close()).toThrow(/already closed/);
  });
});
