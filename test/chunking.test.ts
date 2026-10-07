import { describe, expect, it } from 'vitest';
import { StreamingXmlParser } from '../src/index.js';

/** 归一化事件：记录类型与全部载荷。 */
type Ev =
  | ['start', string, string, string, [string, string, string, string][]]
  | ['end', string, string, string]
  | ['text', string]
  | ['cdata', string]
  | ['comment', string]
  | ['pi', string, string];

function collect(): { events: Ev[]; parser: StreamingXmlParser } {
  const events: Ev[] = [];
  const parser = new StreamingXmlParser({
    events: {
      startElement(n, a) {
        events.push([
          'start',
          n.prefix,
          n.local,
          n.uri,
          a.map((x) => [x.prefix, x.local, x.uri, x.value]),
        ]);
      },
      endElement(n) {
        events.push(['end', n.prefix, n.local, n.uri]);
      },
      text(t) {
        events.push(['text', t]);
      },
      cdata(t) {
        events.push(['cdata', t]);
      },
      comment(t) {
        events.push(['comment', t]);
      },
      processingInstruction(t, d) {
        events.push(['pi', t, d]);
      },
    },
    segmentSize: 53, // 特意取小且不整除常见长度的质数，逼出分段边界问题
  });
  return { events, parser };
}

function parseWhole(doc: string): Ev[] {
  const { events, parser } = collect();
  parser.write(doc).end();
  return events;
}

/** 线性同余伪随机，保证测试可复现。 */
function rngSplits(total: number, seed: number, maxStep: number): number[] {
  const steps: number[] = [];
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  let i = 0;
  while (i < total) {
    const step = Math.min(total - i, 1 + Math.floor(rand() * maxStep));
    steps.push(step);
    i += step;
  }
  return steps;
}

function parseChunked(doc: string, bytes: boolean, seed: number, maxStep = 4): Ev[] {
  const { events, parser } = collect();
  if (bytes) {
    const u = new TextEncoder().encode(doc);
    let i = 0;
    for (const step of rngSplits(u.length, seed, maxStep)) {
      parser.write(u.subarray(i, i + step));
      i += step;
    }
  } else {
    let i = 0;
    for (const step of rngSplits(doc.length, seed, maxStep)) {
      parser.write(doc.slice(i, i + step));
      i += step;
    }
  }
  parser.end();
  return events;
}

const DOCS = [
  String.raw`<root a="1&amp;2"><child>hello 汉字 &#x4e2d; &lt;&gt;&apos;&quot;</child><empty/> <!-- 注释 --><?app data="x"?><![CDATA[<raw> 文本 ]] 结尾]]></root>`,
  '<?xml version="1.0" encoding="UTF-8"?>\n<a xmlns="urn:a"><b xmlns=""><c xmlns:p="urn:p" p:x="v" y="w"/></b></a>\n   \n',
  '<r>' + '0123456789'.repeat(500) + '</r>',
  '<r>' + 'a]'.repeat(400) + '</r>',
  '<r>' + '😀中'.repeat(300) + '</r>',
  '<r a="x">前<!--c--><?p d?>后<![CDATA[z]]>尾</r>',
  '<a><b>1</b><b>2</b><b>3</b></a>',
  '<r>\r\nline1\rline2\n\r\tx</r>',
  '<r attr="&#65;&#x42;\t\n  "/>',
  '<a xmlns="u1"><b xmlns="u2"><c xmlns=""/><d xmlns="u2"/></b><e/></a>',
  '<r>' + '&amp;'.repeat(300) + '</r>',
  '<r>' + '-'.repeat(0) + '<?xx ' + '?'.repeat(100) + 'q?></r>',
];

describe('切块一致性（同一份文档任意切分，事件序列完全相同）', () => {
  for (const [idx, doc] of DOCS.entries()) {
    it(`文档 ${idx}: 整段喂入与 ${DOCS.length > 0 ? 120 : 0} 种随机切块（字节/字符串）结果一致`, () => {
      const baseline = parseWhole(doc);
      for (let seed = 1; seed <= 60; seed++) {
        for (const maxStep of [2, 4, 9]) {
          expect(parseChunked(doc, true, seed, maxStep), `字节切块 seed=${seed} max=${maxStep}`).toEqual(baseline);
          expect(parseChunked(doc, false, seed * 13 + 7, maxStep), `字符串切块 seed=${seed} max=${maxStep}`).toEqual(baseline);
        }
      }
    });
  }

  it('每个边界位置逐字节切一遍（最碎切法）', () => {
    const doc = DOCS[0];
    const baseline = parseWhole(doc);
    const u = new TextEncoder().encode(doc);
    // 全量逐字节太慢，这里对文档前 80 个字节逐个作为切点。
    for (let cut = 0; cut < Math.min(80, u.length); cut++) {
      const { events, parser } = collect();
      parser.write(u.subarray(0, cut));
      parser.write(u.subarray(cut));
      parser.end();
      expect(events, `切点 ${cut}`).toEqual(baseline);
    }
  });

  it('三字节汉字从任意字节位置切开', () => {
    const doc = '<r>汉</r>';
    const baseline = parseWhole(doc);
    const u = new TextEncoder().encode(doc); // < r > E4 BD BD > / r > 之类
    for (let cut = 1; cut < u.length - 1; cut++) {
      const { events, parser } = collect();
      parser.write(u.subarray(0, cut));
      parser.write(u.subarray(cut));
      parser.end();
      expect(events, `切点 ${cut}`).toEqual(baseline);
      expect(events.find((e) => e[0] === 'text')).toEqual(['text', '汉']);
    }
  });

  it('四字节字符（emoji）的代理项对从字符串中间切开', () => {
    const doc = '<r>😀</r>';
    const baseline = parseWhole(doc);
    for (let cut = 3; cut <= 4; cut++) {
      const { events, parser } = collect();
      parser.write(doc.slice(0, cut));
      parser.write(doc.slice(cut));
      parser.end();
      expect(events, `切点 ${cut}`).toEqual(baseline);
    }
  });

  it('CDATA 结束符 "]]>" 从三个字符的每个位置切开', () => {
    const doc = '<r><![CDATA[abc]]></r>';
    const baseline = parseWhole(doc);
    const marker = doc.indexOf(']]>');
    for (let cut = marker; cut <= marker + 3; cut++) {
      const { events, parser } = collect();
      parser.write(doc.slice(0, cut));
      parser.write(doc.slice(cut));
      parser.end();
      expect(events, `切点 ${cut}`).toEqual(baseline);
      expect(events.find((e) => e[0] === 'cdata')).toEqual(['cdata', 'abc']);
    }
  });

  it('文本拼接逐字符等于原文（任意分段）', () => {
    const doc = '<r>' + 'abc汉字😀'.repeat(2000) + '</r>';
    const { events, parser } = collect();
    const u = new TextEncoder().encode(doc);
    for (let i = 0; i < u.length; i += 37) parser.write(u.subarray(i, i + 37));
    parser.end();
    const joined = events.filter((e) => e[0] === 'text').map((e) => e[1]).join('');
    expect([...joined].length).toBe([...doc].length - '<r></r>'.length);
    expect(joined).toBe(doc.slice(3, -4));
  });
});
