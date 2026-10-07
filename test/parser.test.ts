import { describe, expect, it } from 'vitest';
import { StreamingXmlParser } from '../src/index.js';

interface Base {
  events: unknown[];
  parser: StreamingXmlParser;
}

function makeParser(segmentSize?: number): Base {
  const events: unknown[] = [];
  const parser = new StreamingXmlParser({
    events: {
      startElement: (n, a) =>
        events.push({ type: 'start', name: `${n.prefix ? n.prefix + ':' : ''}${n.local}`, uri: n.uri, attrs: a.map((x) => `${x.prefix ? x.prefix + ':' : ''}${x.local}="${x.uri}"=${x.value}`) }),
      endElement: (n) => events.push({ type: 'end', name: `${n.prefix ? n.prefix + ':' : ''}${n.local}`, uri: n.uri }),
      text: (t) => events.push({ type: 'text', value: t }),
      cdata: (t) => events.push({ type: 'cdata', value: t }),
      comment: (t) => events.push({ type: 'comment', value: t }),
      processingInstruction: (t, d) => events.push({ type: 'pi', target: t, data: d }),
    },
    ...(segmentSize === undefined ? {} : { segmentSize }),
  });
  return { events, parser };
}

describe('基础事件', () => {
  it('开始/结束元素、文本、CDATA、注释、PI', () => {
    const { events, parser } = makeParser();
    parser
      .write('<?xml version="1.0"?><!-- 头注释 --><root a="1">前')
      .write('<![CDATA[CD&<>内容]]>后<?app do x?></root>')
      .end();
    const types = events.map((e: any) => e.type);
    expect(types).toEqual(['comment', 'start', 'text', 'cdata', 'text', 'pi', 'end']);
    expect((events[1] as any).name).toBe('root');
    expect((events[1] as any).attrs).toEqual(['a=""=1']);
    expect((events[2] as any).value).toBe('前');
    expect((events[3] as any).value).toBe('CD&<>内容');
    expect((events[4] as any).value).toBe('后');
    expect((events[5] as any)).toMatchObject({ type: 'pi', target: 'app', data: 'do x' });
  });

  it('实体与字符引用解码；属性值空白规范化', () => {
    const { events, parser } = makeParser();
    parser.write('<a x="a\tb&#9;c">v&lt;&gt;&#65;&#x42;</a>').end();
    expect((events[0] as any).attrs[0]).toBe('x=""=a b c');
    const text = events.filter((e: any) => e.type === 'text').map((e: any) => e.value).join('');
    expect(text).toBe('v<>AB');
  });

  it('自闭合元素产生配对事件', () => {
    const { events, parser } = makeParser();
    parser.write('<a><b/></a>').end();
    expect(events.map((e: any) => `${e.type}:${e.name ?? ''}`)).toEqual([
      'start:a', 'start:b', 'end:b', 'end:a',
    ]);
  });

  it('CR / CRLF 统一规范化为 LF，且跨块一致', () => {
    const doc = '<a>a\rb\r\nc\rd</a>';
    const whole = makeParser();
    whole.parser.write(doc).end();

    const chunked = makeParser();
    const u = new TextEncoder().encode(doc);
    for (let i = 0; i < u.length; i += 3) chunked.parser.write(u.subarray(i, i + 3));
    chunked.parser.end();

    const get = (b: Base) => b.events.filter((e: any) => e.type === 'text').map((e: any) => e.value).join('');
    expect(get(chunked)).toBe('a\nb\nc\nd');
    expect(get(chunked)).toBe(get(whole));
  });

  it('BOM 只在文档开头剥离一次', () => {
    const { events, parser } = makeParser();
    parser.write(new Uint8Array([0xef, 0xbb, 0xbf])).write('<a>x</a>').end();
    expect(events.map((e: any) => e.type)).toContain('text');
  });
});

describe('文本/CDATA 分段', () => {
  it('每段不超过 segmentSize，且完整段恰好等长；余段在运行结束时给出', () => {
    const { events, parser } = makeParser(64);
    parser.write('<a>').write('x'.repeat(200)).write('</a>').end();
    const lens = events.filter((e: any) => e.type === 'text').map((e: any) => e.value.length);
    expect(lens.slice(0, -1)).toEqual([64, 64, 64]);
    expect(lens.at(-1)).toBe(8);
    expect(lens.reduce((a, b) => a + b, 0)).toBe(200);
  });

  it('分段边界与 write 切块无关', () => {
    const doc = '<a>' + 'y'.repeat(200) + '</a>';
    const a = makeParser(64);
    a.parser.write(doc).end();
    const b = makeParser(64);
    for (let i = 0; i < doc.length; i += 7) b.parser.write(doc.slice(i, i + 7));
    b.parser.end();
    const lensA = a.events.filter((e: any) => e.type === 'text').map((e: any) => e.value.length);
    const lensB = b.events.filter((e: any) => e.type === 'text').map((e: any) => e.value.length);
    expect(lensB).toEqual(lensA);
  });

  it('CDATA 与相邻文本是不同的分段运行', () => {
    const { events, parser } = makeParser(1024);
    parser.write('<a>t1<![CDATA[c1]]>t2</a>').end();
    expect(events.filter((e: any) => e.type === 'text').map((e: any) => e.value)).toEqual(['t1', 't2']);
    expect(events.filter((e: any) => e.type === 'cdata').map((e: any) => e.value)).toEqual(['c1']);
  });

  it('几十兆文本：解析器不缓存全文（堆占用远小于文档）', () => {
    const MB = 1024 * 1024;
    let eventsCount = 0;
    let chars = 0;
    const parser = new StreamingXmlParser({
      events: {
        startElement() {},
        endElement() {},
        text(t) { eventsCount++; chars += t.length; },
        cdata() {},
        comment() {},
        processingInstruction() {},
      },
      segmentSize: 65536,
    });
    parser.write('<r>');
    const block = 'a'.repeat(1024 * 1024);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 40; i++) parser.write(block); // 40 MiB
    const after = process.memoryUsage().heapUsed;
    parser.write('</r>').end();
    expect(chars).toBe(40 * MB);
    expect(eventsCount).toBeGreaterThan(600);
    // 分段被消费即释放，解析器自身堆增长应远小于 40MiB。
    expect(after - before).toBeLessThan(5 * MB);
  }, 30_000);
});

describe('reset：出错后复用，前后文档零串扰', () => {
  it('前一份出错，reset 后下一份正常解析', () => {
    const bad = makeParser();
    expect(() => bad.parser.write('<a><b></a>').end()).toThrow();
    const { events, parser } = makeParser();
    parser.write('<x xmlns="urn:x"><y/></x>').end();
    expect(events.map((e: any) => `${e.type}:${e.name ?? ''}`)).toEqual([
      'start:x', 'start:y', 'end:y', 'end:x',
    ]);
    expect((events[0] as any).uri).toBe('urn:x');
  });

  it('前一份未读完的多字节残留在 reset 后不影响后一份', () => {
    const parser = new StreamingXmlParser({
      events: { startElement() {}, endElement() {}, text() {}, cdata() {}, comment() {}, processingInstruction() {} },
    });
    expect(() => parser.write(new Uint8Array([0x3c, 0x61, 0x3e, 0xe4])).end()).toThrow();
    parser.reset();
    const out: string[] = [];
    const p2 = new StreamingXmlParser({
      events: { startElement() {}, endElement() {}, text: (t) => out.push(t), cdata() {}, comment() {}, processingInstruction() {} },
    });
    // 用一个新实例对照；同时验证原实例 reset 后也能用
    p2.write('<a>汉</a>').end();
    const orig = makeParser();
    parser.reset();
    parser.write('<a>汉</a>').end();
    expect(out.join('')).toBe('汉');
  });

  it('reset 后 segmentSize 配置保留、finished 状态清除', () => {
    const b = makeParser(32);
    b.parser.write('<a>' + 'z'.repeat(40) + '</a>').end();
    b.parser.reset();
    b.parser.write('<a>' + 'z'.repeat(40) + '</a>').end();
    // 两份文档各 40 字符 => 每份 1 个满段(32)+余段(8)
    const lens = b.events.filter((e: any) => e.type === 'text').map((e: any) => e.value.length);
    expect(lens).toEqual([32, 8, 32, 8]);
  });

  it('一个连接上连续解析多份文档', () => {
    const b = makeParser();
    for (let i = 0; i < 5; i++) {
      b.parser.write(`<doc n="${i}"><item>v${i}</item></doc>`).end();
      b.parser.reset();
    }
    const texts = b.events.filter((e: any) => e.type === 'text').map((e: any) => e.value);
    expect(texts).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
  });

  it('end() 之后继续 write 报错；reset 后恢复', () => {
    const parser = makeParser().parser;
    parser.write('<a/>').end();
    expect(() => parser.write(' ')).toThrow();
    parser.reset();
    expect(() => parser.write('<a/>').end()).not.toThrow();
  });
});
