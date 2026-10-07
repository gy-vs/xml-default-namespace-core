import { describe, expect, it } from 'vitest';
import { StreamingXmlParser, XmlParseError } from '../src/index.js';

function mustThrow(doc: string, chunks?: (string | Uint8Array)[]): XmlParseError {
  const p = new StreamingXmlParser({
    events: {
      startElement() {},
      endElement() {},
      text() {},
      cdata() {},
      comment() {},
      processingInstruction() {},
    },
  });
  const run = () => {
    if (chunks) {
      for (const c of chunks) p.write(c);
    } else {
      p.write(doc);
    }
    p.end();
  };
  try {
    run();
  } catch (e) {
    if (e instanceof XmlParseError) return e;
    throw e;
  }
  throw new Error('预期抛错但没有');
}

describe('错误：行列号与原因', () => {
  it('标签没闭合', () => {
    const e = mustThrow('<a><b></a>');
    expect(e.message).toMatch(/结束标签|不匹配/);
  });

  it('根元素未闭合（EOF）', () => {
    const e = mustThrow('<a><b>text</b>');
    expect(e.message).toMatch(/没有闭合标签/);
    expect(e.line).toBeGreaterThanOrEqual(1);
    expect(e.column).toBeGreaterThanOrEqual(1);
  });

  it('结束标签与开始标签不匹配', () => {
    const e = mustThrow('<a></b>');
    expect(e.message).toMatch(/不匹配/);
  });

  it('行列号随换行推进', () => {
    const doc = '<a>\n  <b>\n  </c>';
    const e = mustThrow(doc);
    expect(e.line).toBe(3);
  });

  it('多余的结束标签', () => {
    expect(() => {
      const p = new StreamingXmlParser({
        events: { startElement() {}, endElement() {}, text() {}, cdata() {}, comment() {}, processingInstruction() {} },
      });
      p.write('<a/>').end();
    }).not.toThrow();
    expect(mustThrow('<a></a></a>').message).toMatch(/没有对应的开始标签|根元素之后|头尾部/);
  });

  it('使用未声明前缀', () => {
    expect(mustThrow('<p:a xmlns:q="u"/>').message).toMatch(/未声明/);
  });

  it('非法字符引用：超出码位、代理码点、数字不合法', () => {
    expect(mustThrow('<a>&#xFFFFFF;</a>').message).toMatch(/非法字符/);
    expect(mustThrow('<a>&#xD800;</a>').message).toMatch(/非法字符/);
    expect(mustThrow('<a>&#zzz;</a>').message).toMatch(/非法/);
    expect(mustThrow('<a>&#999999999999;</a>').message).toMatch(/非法/);
  });

  it('不认识的实体名一律拒绝（只认五个预定义实体）', () => {
    expect(mustThrow('<a>&nbsp;</a>').message).toMatch(/不支持的实体引用/);
    expect(mustThrow('<a>&custom;</a>').message).toMatch(/不支持的实体引用/);
    expect(mustThrow('<a a="&x;"/>').message).toMatch(/不支持的实体引用/);
  });

  it('引用未以分号闭合 / 裸 &', () => {
    expect(mustThrow('<a>&amp</a>').message).toMatch(/分号/);
    expect(mustThrow('<a>a & b</a>').message).toMatch(/分号|引用/);
  });

  it('文本中出现 "]]>"', () => {
    expect(mustThrow('<a>x]]>y</a>').message).toMatch(/]]>/);
  });

  it('注释中出现 "--" 或以 - 结尾', () => {
    expect(mustThrow('<a><!--a--b--></a>').message).toMatch(/--/);
    expect(mustThrow('<a><!--a---></a>').message).toMatch(/--/);
  });

  it('未终止的注释/CDATA/PI/属性值在 end() 报错', () => {
    expect(mustThrow('<a><!-- unterminated').message).toMatch(/未闭合|未终止/);
    expect(mustThrow('<a><![CDATA[unterminated').message).toMatch(/未闭合|未终止/);
    expect(mustThrow('<a><?pi unterminated').message).toMatch(/未闭合|未终止/);
    expect(mustThrow('<a a="unterminated').message).toMatch(/未闭合|未终止/);
  });

  it('缺少根元素', () => {
    expect(mustThrow('').message).toMatch(/根元素/);
    expect(mustThrow('   <!-- only comment -->').message).toMatch(/根元素/);
    expect(mustThrow('<?pi only?>').message).toMatch(/根元素/);
  });

  it('根元素之外出现第二个元素 / 非空白文本', () => {
    expect(mustThrow('<a/><b/>').message).toMatch(/根元素之后/);
    expect(mustThrow('<a/>tail').message).toMatch(/根元素之后/);
    expect(mustThrow('head<a/>').message).toMatch(/根元素之前/);
  });

  it('属性值中出现 "<"', () => {
    expect(mustThrow('<a x="a<b"/>').message).toMatch(/不允许出现 "<"|属性/);
  });

  it('未加引号的属性值、属性语法错误', () => {
    expect(mustThrow('<a x=1/>').message).toMatch(/引号/);
    expect(mustThrow('<a x />').message).toMatch(/=/);
  });

  it('非法的 UTF-8 字节序列', () => {
    // overlong 编码 0xc0 后紧跟 ASCII，在流式解码过程中即可判定为非法。
    const bad = new Uint8Array([0x3c, 0x61, 0x3e, 0xc0, 0x20, 0x3c, 0x2f, 0x61, 0x3e]);
    expect(mustThrow('', [bad]).message).toMatch(/UTF-8/);
  });

  it('文档在残缺的多字节序列中结束', () => {
    const p = new StreamingXmlParser({
      events: {
        startElement() {}, endElement() {}, text() {}, cdata() {}, comment() {},
        processingInstruction() {},
      },
    });
    p.write(new Uint8Array([0x3c, 0x61, 0x3e, 0xe4, 0xbd])); // "汉" 的前两字节
    expect(() => p.end()).toThrowError(/UTF-8|多字节/);
  });

  it('处理指令目标不能是保留名 xml（任意大小写组合都被保留）', () => {
    // 普通 PI 目标合法
    expect(() => {
      const p = new StreamingXmlParser({
        events: { startElement() {}, endElement() {}, text() {}, cdata() {}, comment() {}, processingInstruction() {} },
      });
      p.write('<?xmlx data?><a/>').end();
    }).not.toThrow();
    // xml 的任意大小写变体都被保留
    expect(mustThrow('<?XML d?><a/>').message).toMatch(/保留/);
    // 元素内容里出现目标为 xml 的 PI 非法（它只能是文档头声明）
    expect(mustThrow('<a><?xml version="1.0"?></a>').message).toMatch(/XML 声明|xml/);
    // 第二个 xml 声明也非法
    expect(mustThrow('<?xml version="1.0"?><a/><?xml version="1.0"?>').message).toMatch(/XML 声明|xml/);
  });
});

describe('DOCTYPE 与实体安全', () => {
  it('允许没有内部子集的 DOCTYPE', () => {
    const p = new StreamingXmlParser({
      events: {
        startElement() {}, endElement() {}, text() {}, cdata() {}, comment() {},
        processingInstruction() {},
      },
    });
    expect(() => p.write('<!DOCTYPE root><root/>').end()).not.toThrow();
  });

  it('拒绝内部实体声明（防实体膨胀）', () => {
    expect(mustThrow('<!DOCTYPE a [<!ENTITY x "y">]><a/>').message).toMatch(/实体/);
    expect(mustThrow('<!DOCTYPE a [ <!ENTITY  x SYSTEM "u"> ]><a/>').message).toMatch(/实体/);
  });

  it('拒绝参数实体引用', () => {
    expect(mustThrow('<!DOCTYPE a [%ext;]><a/>').message).toMatch(/参数实体/);
  });

  it('DOCTYPE 只能出现在头部且只一次', () => {
    expect(mustThrow('<a/><!DOCTYPE a>').message).toMatch(/DOCTYPE/);
    expect(mustThrow('<!DOCTYPE a><!DOCTYPE a><a/>').message).toMatch(/DOCTYPE/);
  });
});

describe('错误在任意切块方式下稳定复现', () => {
  const docs = [
    '<a><b></a>',
    '<a>&undefined;</a>',
    '<p:a/>',
    '<a>x]]>y</a>',
    '<a><!-- bad --!></a>',
  ];
  for (const doc of docs) {
    it(`${doc} 逐字节切分时同样报错`, () => {
      const u = new TextEncoder().encode(doc);
      let first: string | undefined;
      for (let cut = 0; cut < u.length; cut++) {
        const p = new StreamingXmlParser({
          events: {
            startElement() {}, endElement() {}, text() {}, cdata() {}, comment() {},
            processingInstruction() {},
          },
        });
        let err: Error | undefined;
        try {
          p.write(u.subarray(0, cut));
          p.write(u.subarray(cut));
          p.end();
        } catch (e) {
          err = e as Error;
        }
        expect(err, `切点 ${cut} 应当报错`).toBeDefined();
        first ??= err!.message.replace(/第 \d+ 行第 \d+ 列/, 'LOC');
        expect(err!.message.replace(/第 \d+ 行第 \d+ 列/, 'LOC')).toBe(first);
      }
    });
  }
});
