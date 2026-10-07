import {describe, expect, it} from 'vitest';
import {SaxParser} from '../src/index.js';
import {
  assertSameEventsAcrossCuts,
  joinText,
  parseChopped,
  parseWhole,
} from './helpers.js';

describe('events and decoded content', () => {
  it('concatenated text events equal the decoded source exactly', () => {
    const doc =
      '<r>plain &amp; &#65;&#x42; &#xE9; mixed <b>inner</b> tail&#x1F600;</r>';
    const ev = parseWhole(doc);
    expect(joinText(ev)).toBe('plain & AB é mixed inner tail😀');
  });

  it('text is stable across chunkings even with multi-byte chars', () => {
    const doc =
      '<r>中文 &#x4E2D; emoji😀 &amp; <a>嵌套€</a> end</r>';
    assertSameEventsAcrossCuts(doc);
    expect(joinText(parseChopped(doc, [1]))).toBe('中文 中 emoji😀 & 嵌套€ end');
  });

  it('delivers CDATA verbatim without entity expansion', () => {
    const doc = '<r><![CDATA[<a>&amp;&#65;]]>after</r>';
    const ev = parseWhole(doc);
    const cdata = ev.filter((e) => e.type === 'cdata').map((e) => e.text).join('');
    expect(cdata).toBe('<a>&amp;&#65;');
    expect(joinText(ev)).toBe('<a>&amp;&#65;after');
  });

  it('expresses a literal "]]>" with two adjacent CDATA sections', () => {
    // The canonical XML encoding of the text a]]>b]]>c is two CDATA sections
    // plus a plain segment; verify it round-trips under every cut.
    const doc = '<r><![CDATA[a]]]]><![CDATA[>b]]]]><![CDATA[>c]]></r>';
    assertSameEventsAcrossCuts(doc);
    expect(joinText(parseChopped(doc, [1]))).toBe('a]]>b]]>c');
  });

  it('preserves comments with surrounding whitespace', () => {
    const doc = '<r><!--  a <b> &amp;  --></r>';
    const ev = parseWhole(doc);
    const c = ev.find((e) => e.type === 'comment');
    expect(c && c.text).toBe('  a <b> &amp;  ');
  });

  it('delivers PI target and data', () => {
    const doc = '<r><?app do="it"?>x<?empty?></r>';
    const ev = parseWhole(doc);
    const pis = ev.filter((e) => e.type === 'processingInstruction');
    expect(pis).toEqual([
      {type: 'processingInstruction', target: 'app', data: 'do="it"'},
      {type: 'processingInstruction', target: 'empty', data: ''},
    ]);
  });

  it('parses the XML declaration without emitting a PI', () => {
    const doc = '<?xml version="1.0"?><r/>';
    const ev = parseWhole(doc);
    expect(ev.some((e) => e.type === 'processingInstruction')).toBe(false);
    expect(ev.some((e) => e.type === 'startElement')).toBe(true);
  });

  it('rejects a second xml-like PI target and reserved xml target in body', () => {
    for (const bad of ['<?xmlx?>', '<?XML-stylesheet?>']) {
      const {events} = (() => {
        const out: string[] = [];
        const p = new SaxParser();
        let threw = false;
        try {
          p.write(Buffer.from(bad));
          p.close();
        } catch {
          threw = true;
        }
        out.push(threw ? 'THREW' : 'OK');
        return {events: out};
      })();
      expect(events[0]).toBe('THREW');
    }
  });

  it('rejects an XML declaration preceded by anything but the BOM', () => {
    for (const bad of [' <?xml version="1.0"?><r/>', '\n<?xml version="1.0"?><r/>']) {
      const p = new SaxParser();
      let threw = false;
      try {
        p.write(Buffer.from(bad));
        p.close();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
    // A leading BOM followed by the declaration is legal.
    const ok = new SaxParser();
    expect(() => {
      ok.write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0"?><r/>')]));
      ok.close();
    }).not.toThrow();
  });

  it('emits self-closing start and end with the resolved name', () => {
    const doc = '<a xmlns:p="urn:p"><p:b/></a>';
    const ev = parseWhole(doc);
    const b1 = ev.find((e) => e.type === 'startElement' && e.local === 'b') as any;
    const b2 = ev.find((e) => e.type === 'endElement' && e.local === 'b') as any;
    expect(b1.uri).toBe('urn:p');
    expect(b2.uri).toBe('urn:p');
  });

  it('attribute value expands entities and normalizes line endings', () => {
    const doc = '<r a="x&amp;y&#65;z"/>';
    const ev = parseWhole(doc);
    const a = (ev.find((e) => e.type === 'startElement') as any).attributes[0];
    expect(a.value).toBe('x&yAz');
  });

  it('attribute CR and CRLF both become a single LF under every cut', () => {
    const doc = '<r a="l1\r\nl2\rl3"/>';
    assertSameEventsAcrossCuts(doc);
    const a = (parseChopped(doc, [1]).find((e) => e.type === 'startElement') as any)
      .attributes[0];
    expect(a.value).toBe('l1\nl2\nl3');
  });

  it('whitespace-only prolog/epilog and inter-element text parse cleanly', () => {
    const doc = '\n <?pi x?>\n <a>\n  <b/>\n </a>\n <?pi y?>\n ';
    assertSameEventsAcrossCuts(doc);
  });

  it('document order is interleaved: text, cdata, comments, elements', () => {
    const doc = '<r>a<!--c--><![CDATA[d]]>b</r>';
    const kinds = parseWhole(doc)
      .map((e) => e.type)
      .filter((t) => t !== 'startDocument' && t !== 'endDocument');
    expect(kinds).toEqual([
      'startElement',
      'text',
      'comment',
      'cdata',
      'text',
      'endElement',
    ]);
  });
});
