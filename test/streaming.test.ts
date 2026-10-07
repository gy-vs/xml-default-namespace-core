import {describe, expect, it} from 'vitest';
import {Buffer} from 'node:buffer';
import {SaxError, SaxParser} from '../src/index.js';
import {joinText} from './helpers.js';
import type {Event} from './helpers.js';

function collect(): {events: Event[]; p: SaxParser} {
  const events: Event[] = [];
  const p = new SaxParser({
    textChunkSize: 1024,
    handlers: {
      startElement: (n, a) => events.push({type: 'startElement', prefix: n.prefix, local: n.local, uri: n.uri, attributes: a.map((x) => ({prefix: x.name.prefix, local: x.name.local, uri: x.name.uri, value: x.value}))}),
      endElement: (n) => events.push({type: 'endElement', prefix: n.prefix, local: n.local, uri: n.uri}),
      text: (t) => events.push({type: 'text', text: t}),
      cdata: (t) => events.push({type: 'cdata', text: t}),
      comment: (t) => events.push({type: 'comment', text: t}),
      processingInstruction: (t, d) => events.push({type: 'processingInstruction', target: t, data: d}),
      startDocument: () => events.push({type: 'startDocument'}),
      endDocument: () => events.push({type: 'endDocument'}),
    },
  });
  return {events, p};
}

describe('streaming text delivery', () => {
  it('emits large text nodes in multiple bounded chunks before the end tag', () => {
    const N = 100_000;
    const content = 'x'.repeat(N);
    const doc = Buffer.from('<r>' + content + '</r>');
    const {events, p} = collect();
    const textChunks: string[] = [];
    let sawEndTag = false;
    p.on('endElement', () => {
      sawEndTag = true;
    });
    p.on('text', (t) => {
      expect(sawEndTag).toBe(false); // text must precede the end element event
      textChunks.push(t);
    });
    // Feed in small network-sized pieces.
    for (let off = 0; off < doc.length; off += 4096) {
      p.write(doc.subarray(off, off + 4096));
    }
    p.close();

    expect(textChunks.length).toBeGreaterThan(1);
    for (const c of textChunks) expect(c.length).toBeLessThanOrEqual(1024 + 2);
    expect(textChunks.join('')).toBe(content);
  });

  it('streams CDATA in bounded chunks and reassembles exactly', () => {
    const content = '中'.repeat(20_000) + '<![CDATA test';
    const doc = Buffer.from('<r><![CDATA[' + content + ']]></r>');
    const {events, p} = collect();
    const chunks: string[] = [];
    p.on('cdata', (t) => chunks.push(t));
    let off = 0;
    while (off < doc.length) {
      p.write(doc.subarray(off, Math.min(off + 137, doc.length)));
      off += 137;
    }
    p.close();
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(content);
    void events;
  });

  it('parser retained memory stays bounded for a huge document', () => {
    // A ~60 MB document with a single enormous text node. The parser must not
    // accumulate the text; we measure process heap growth while dropping
    // delivered chunks immediately.
    const target = 60 * 1024 * 1024;
    const chunk = Buffer.from('<r>');
    const tail = Buffer.from('</r>');
    const bodyPiece = Buffer.from('abcdef0123'.repeat(1000)); // 10 KB

    const p = new SaxParser({
      handlers: {
        text: () => {
          /* drop immediately */
        },
      },
      textChunkSize: 1 << 16,
    });
    p.write(chunk);
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let written = 0;
    while (written < target) {
      p.write(bodyPiece);
      written += bodyPiece.length;
    }
    p.write(tail);
    p.close();
    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    // Heap should not grow proportionally to the 60 MB fed through.
    expect(after - before).toBeLessThan(12 * 1024 * 1024);
  });
});

describe('reset and multi-document reuse', () => {
  it('parses many documents on one parser instance after reset()', () => {
    const p = new SaxParser();
    const docs = [
      '<a xmlns="urn:1"><b/></a>',
      '<p:x xmlns:p="urn:p">y</p:x>',
      '<r><!-- c --><![CDATA[d]]></r>',
      '<z/>',
    ];
    for (const doc of docs) {
      p.reset();
      const seen: string[] = [];
      (p as any).handlers = {
        startElement: (n: any) => seen.push(`<${n.local}@${n.uri}`),
        endElement: (n: any) => seen.push(`</${n.local}@${n.uri}`),
        text: (t: string) => seen.push(`t:${t}`),
      };
      p.write(Buffer.from(doc));
      p.close();
      expect(seen.length).toBeGreaterThan(1);
      expect(seen[0]).toContain('<');
      expect(seen[seen.length - 1]).toContain('</');
    }
  });

  it('a failure leaves no residue: next doc after reset parses cleanly', () => {
    const p = new SaxParser();
    const bad = '<a xmlns:p="urn:p"><p:b><c/></a>';
    expect(() => {
      p.write(Buffer.from(bad));
      p.close();
    }).toThrow(SaxError);

    // Must not be usable without reset.
    expect(() => p.write(Buffer.from('<r/>'))).toThrow(SaxError);

    p.reset();
    const seen: string[] = [];
    (p as any).handlers = {
      startElement: (n: any) => seen.push(`<${n.local}`),
      endElement: (n: any) => seen.push(`</${n.local}`),
    };
    // The prefix p from the previous document must NOT be in scope.
    expect(() => {
      p.write(Buffer.from('<p:z xmlns:p="urn:fresh"/>'));
      p.close();
    }).not.toThrow();
    expect(seen).toEqual(['<z', '</z']);
  });

  it('namespace bindings, stack and pending text do not leak across reset', () => {
    const p = new SaxParser();
    expect(() => {
      p.write(Buffer.from('<r xmlns="urn:leak"><nested>'));
      p.close();
    }).toThrow();
    p.reset();
    const got: any[] = [];
    (p as any).handlers = {
      startElement: (n: any) => got.push([n.local, n.uri]),
      endElement: (n: any) => got.push(['/' + n.local, n.uri]),
    };
    p.write(Buffer.from('<s>x</s>'));
    p.close();
    expect(got).toEqual([
      ['s', ''],
      ['/s', ''],
    ]);
  });

  it('utf-8 decoder state does not leak across reset', () => {
    const p = new SaxParser();
    expect(() => {
      p.write(Buffer.from([0xe4, 0xb8])); // truncated 中
      p.close();
    }).toThrow();
    p.reset();
    let text = '';
    (p as any).handlers = {text: (t: string) => (text += t)};
    p.write(Buffer.from('<r>ok</r>'));
    p.close();
    expect(text).toBe('ok');
  });
});
