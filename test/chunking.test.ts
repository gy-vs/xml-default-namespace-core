import {describe, expect, it} from 'vitest';
import {SaxParser} from '../src/index.js';
import {
  assertSameEventsAcrossCuts,
  collectEvents,
  joinText,
  parseChopped,
  parseWhole,
  randomCuts,
} from './helpers.js';

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a prolog comment -->
<root xmlns="urn:default" xmlns:a="urn:a" xmlns:b="urn:b">
  <a:item a:x="1" b:y="2" plain="three" a:z="&amp;">
    text with <b:mid>mixed</b:mid> content &amp; entities &#x4E2D;
  </a:item>
  <![CDATA[raw <>& stuff]]>
  <a:item a:x="1" b:y="2" plain="three" a:z="&amp;">
    text with <b:mid>mixed</b:mid> content &amp; entities &#x4E2D;
  </a:item>
  <?app do-something useful?>
</root>
<!-- epilog -->
`;

describe('event consistency across arbitrary chunkings', () => {
  it('whole-feed parse produces the expected event skeleton', () => {
    const events = parseWhole(DOC);
    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe('startDocument');
    expect(kinds[kinds.length - 1]).toBe('endDocument');
    for (const k of [
      'startElement',
      'endElement',
      'text',
      'cdata',
      'comment',
      'processingInstruction',
    ] as const) {
      expect(kinds).toContain(k);
    }

    const root = events.find((e) => e.type === 'startElement')!;
    if (root.type !== 'startElement') throw new Error('impossible');
    expect(root.local).toBe('root');
    expect(root.uri).toBe('urn:default');
    expect(root.prefix).toBe('');
  });

  it('every fixed cut plan yields the exact same event sequence', () => {
    assertSameEventsAcrossCuts(DOC);
  });

  it('random byte cut plans all agree', () => {
    const plans = randomCuts(DOC, 0xc0ffee, 10);
    for (const plan of plans.slice(1)) expect(plan).toEqual(plans[0]);
    expect(plans[0]).toEqual(parseWhole(DOC));
  });

  it('cutting through a 3-byte Chinese character preserves it', () => {
    const doc = '<r>中文测试&#x4E2D;文</r>';
    assertSameEventsAcrossCuts(doc);
    const events = parseChopped(doc, [1]);
    expect(joinText(events)).toBe('中文测试中文');
  });

  it('cutting through the CDATA closing sequence preserves content', () => {
    const doc = '<r><![CDATA[abc]]]]><![CDATA[>def]]></r>';
    assertSameEventsAcrossCuts(doc);
    const events = parseChopped(doc, [1]);
    expect(joinText(events)).toBe('abc]]>def');
  });

  it('cutting between every byte of a tag and attribute still works', () => {
    const doc = '<r a="1" b="x&gt;y"><c/></r>';
    assertSameEventsAcrossCuts(doc);
  });

  it('empty writes do not change anything', () => {
    const bytes = Buffer.from(DOC, 'utf8');
    const {events, handlers} = collectEvents();
    const p = new SaxParser({handlers, textChunkSize: 64});
    const sizes = [0, 5, 0, 0, 3, 0, 8, 0];
    let off = 0;
    let si = 0;
    while (off < bytes.length) {
      const raw = sizes[si % sizes.length];
      const size = Math.min(raw, bytes.length - off);
      p.write(bytes.subarray(off, off + size));
      off += size;
      si++;
    }
    p.write(new Uint8Array(0));
    p.write('');
    p.close();
    expect(events).toEqual(parseWhole(DOC));
  });

  it('CR and CRLF normalize to LF identically under every cut', () => {
    const crlf = '<r>\r\n<a>x\ry</a>\r</r>';
    const events = assertSameEventsAcrossCuts(crlf);
    expect(joinText(events)).toBe('\nx\ny\n');
  });
});
