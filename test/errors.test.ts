import {describe, expect, it} from 'vitest';
import {Buffer} from 'node:buffer';
import {SaxError, SaxParser} from '../src/index.js';

function parse(doc: string | Uint8Array, sizes?: number[]) {
  const events: string[] = [];
  const p = new SaxParser({
    handlers: {
      startElement: (n) => events.push(`<${n.prefix ? n.prefix + ':' : ''}${n.local}`),
      endElement: (n) => events.push(`</${n.prefix ? n.prefix + ':' : ''}${n.local}`),
      text: (t) => events.push(`t:${t}`),
      cdata: (t) => events.push(`c:${t}`),
      comment: (t) => events.push(`#:${t}`),
      processingInstruction: (t, d) => events.push(`?:${t}=${d}`),
    },
  });
  const bytes = typeof doc === 'string' ? Buffer.from(doc) : Buffer.from(doc);
  let error: SaxError | undefined;
  try {
    if (sizes) {
      let off = 0;
      let si = 0;
      while (off < bytes.length) {
        const sz = Math.min(sizes[si++ % sizes.length], bytes.length - off);
        p.write(bytes.subarray(off, off + sz));
        off += sz;
      }
    } else {
      p.write(bytes);
    }
    p.close();
  } catch (e) {
    if (e instanceof SaxError) error = e;
    else throw e;
  }
  return {error, events};
}

describe('well-formedness errors', () => {
  const fails = (doc: string, fragment: RegExp | string) => {
    const {error} = parse(doc);
    expect(error, 'expected a SaxError').toBeInstanceOf(SaxError);
    if (fragment instanceof RegExp) expect(error!.message).toMatch(fragment);
    else expect(error!.message).toContain(fragment);
    return error!;
  };

  it('unclosed element at EOF', () => {
    const e = fails('<r>', /unclosed element|unexpected/);
    void e;
  });

  it('unclosed start tag (no >)', () => {
    fails('<r a="1"', 'unclosed start tag');
  });

  it('mismatched end tag', () => {
    fails('<a><b></c></b></a>', 'mismatched end tag');
  });

  it('end tag with no open element', () => {
    fails('<a/></a>', 'no open element');
  });

  it('unclosed comment', () => {
    fails('<r><!-- never ends</r>', 'unclosed comment');
  });

  it('illegal double dash inside comment', () => {
    fails('<r><!-- a -- b --></r>', '--');
  });

  it('unclosed CDATA', () => {
    fails('<r><![CDATA[ never ends</r>', 'unclosed CDATA');
  });

  it('unclosed processing instruction', () => {
    fails('<?pi do stuff', 'unclosed processing instruction');
  });

  it('unbound namespace prefix on element', () => {
    fails('<p:a/>', 'unbound namespace prefix');
  });

  it('unbound namespace prefix on attribute', () => {
    fails('<a p:x="1" xmlns:p="urn:p"><b q:y="2"/></a>', 'unbound namespace prefix');
  });

  it('undeclared named entity is rejected', () => {
    fails('<r>&bogus;</r>', 'undeclared entity');
  });

  it('the five predefined entities are accepted', () => {
    const {error, events} = parse('<r>a&lt;b&gt;c&amp;d&apos;e&quot;f</r>');
    expect(error).toBeUndefined();
    expect(events.join('')).toContain('t:a<b>c&d\'e"f');
  });

  it('numeric character references decimal and hex are accepted', () => {
    const {error, events} = parse('<r>&#65;&#x42;&#xE9;</r>');
    expect(error).toBeUndefined();
    expect(events.join('')).toContain('ABé');
  });

  it('illegal decimal character reference (surrogate)', () => {
    fails('<r>&#xD800;</r>', 'illegal character reference');
  });

  it('illegal hex character reference (control char 0x01)', () => {
    fails('<r>&#x1;</r>', 'illegal character reference');
  });

  it('malformed numeric character reference', () => {
    fails('<r>&#zz;</r>', 'illegal');
  });

  it('malformed entity reference without semicolon', () => {
    fails('<r>&amp no-semi</r>', 'entity reference');
  });

  it('rejects an internal DTD subset with an entity declaration', () => {
    fails(
      '<!DOCTYPE r [<!ENTITY x "boom">]><r/>',
      'internal DTD',
    );
  });

  it('accepts an external DOCTYPE without internal subset', () => {
    const {error} = parse('<!DOCTYPE r SYSTEM "x.dtd"><r/>');
    expect(error).toBeUndefined();
  });

  it('accepts a PUBLIC DOCTYPE', () => {
    const {error} = parse('<!DOCTYPE r PUBLIC "-//X//DTD Y//EN" "x.dtd"><r/>');
    expect(error).toBeUndefined();
  });

  it('rejects a second root element', () => {
    fails('<a/><b/>', 'multiple root');
  });

  it('rejects text directly outside the root', () => {
    fails('nope<a/>', 'outside the root element');
  });

  it('rejects a document with no root', () => {
    fails('<!-- only a comment -->', 'no root element');
  });

  it('rejects invalid UTF-8 (truncated multibyte sequence)', () => {
    // E4 B8 AD is 中 in UTF-8; drop the final byte.
    const bytes = Buffer.concat([Buffer.from('<r>'), Buffer.from([0xe4, 0xb8]), Buffer.from('</r>')]);
    const {error} = parse(bytes);
    expect(error).toBeInstanceOf(SaxError);
    expect(error!.message).toMatch(/UTF-8/);
  });

  it('raw control character is illegal', () => {
    const bytes = Buffer.concat([Buffer.from('<r>a'), Buffer.from([0x01]), Buffer.from('b</r>')]);
    const {error} = parse(bytes);
    expect(error).toBeInstanceOf(SaxError);
  });

  it('attribute value must be quoted', () => {
    fails('<r a=1/>', 'quoted');
  });

  it('duplicate plain attribute', () => {
    fails('<r a="1" a="2"/>', 'duplicate attribute');
  });

  it('redeclaring xml prefix wrongly', () => {
    fails('<r xmlns:xml="urn:other"/>', 'xml');
  });
});

describe('line and column reporting', () => {
  it('points at an unbound prefix on line 3', () => {
    const doc = '<r>\n  <good/>\n  <p:bad/>\n</r>';
    const {error} = parse(doc);
    expect(error).toBeInstanceOf(SaxError);
    expect(error!.line).toBe(3);
    expect(error!.column).toBe(3); // the '<' starting the bad tag
  });

  it('advances columns on a single line', () => {
    const doc = '<r><a/><p:b/></r>';
    const {error} = parse(doc);
    expect(error!.line).toBe(1);
    expect(error!.column).toBe(8); // '<' of <p:b/>
  });

  it('counts a CRLF as one line break', () => {
    const doc = '<r>\r\n  <p:b/>\r\n</r>';
    const {error} = parse(doc);
    expect(error!.line).toBe(2);
    expect(error!.column).toBe(3);
  });

  it('mismatch error reports the offending end tag line', () => {
    const doc = '<r>\n<a>\n</b>\n</a>\n</r>';
    const {error} = parse(doc);
    expect(error!.line).toBe(3);
  });
});

describe('error message stability across chunkings', () => {
  const docs = [
    '<r>\n  <p:a/>\n</r>',
    '<a><b></c></b></a>',
    '<r>&#x1;</r>',
    '<!-- never closed',
    '<r>&bogus;</r>',
  ];

  for (const doc of docs) {
    it(`same reason/line/column for ${JSON.stringify(doc)}`, () => {
      const whole = parse(doc);
      expect(whole.error).toBeInstanceOf(SaxError);
      const key = (e: SaxError) =>
        `${e.message.split(' (line')[0]}@${e.line}:${e.column}`;
      for (const sizes of [[1], [2], [3, 1, 7], [16, 1]]) {
        const chopped = parse(doc, sizes);
        expect(chopped.error, `no error when cut ${sizes}`).toBeInstanceOf(SaxError);
        expect(key(chopped.error!)).toBe(key(whole.error!));
      }
    });
  }
});
