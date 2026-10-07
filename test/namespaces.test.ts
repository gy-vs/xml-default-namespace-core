import { describe, expect, it } from 'vitest';
import { StreamingXmlParser, XML_NS, XMLNS_NS } from '../src/index.js';
import type { QName, ResolvedAttribute } from '../src/index.js';

interface Rec {
  type: 's' | 'e';
  name: QName;
  attrs?: ResolvedAttribute[];
}

function parse(doc: string, chunks?: number[]): Rec[] {
  const out: Rec[] = [];
  const p = new StreamingXmlParser({
    events: {
      startElement(name, attributes) {
        out.push({ type: 's', name, attrs: attributes });
      },
      endElement(name) {
        out.push({ type: 'e', name });
      },
      text() {},
      cdata() {},
      comment() {},
      processingInstruction() {},
    },
  });
  if (chunks) {
    let i = 0;
    for (const k of chunks) {
      p.write(doc.slice(i, i + k));
      i += k;
    }
  } else {
    p.write(doc);
  }
  p.end();
  return out;
}

describe('默认命名空间作用域', () => {
  it('内层重新声明默认命名空间、再用 xmlns="" 清空、兄弟节点恢复外层绑定', () => {
    const doc =
      '<a xmlns="urn:outer">' +
      '<b xmlns="urn:middle"><c/></b>' +
      '<d xmlns=""><e/></d>' +
      '<f/>' +
      '</a>';
    const recs = parse(doc);
    const uriOf = (i: number) => recs[i].name.uri;
    expect(uriOf(0)).toBe('urn:outer'); // a
    expect(uriOf(1)).toBe('urn:middle'); // b start
    expect(uriOf(2)).toBe('urn:middle'); // c 继承 middle
    expect(uriOf(5)).toBe(''); // d 被清空
    expect(uriOf(6)).toBe(''); // e 仍无命名空间
    expect(uriOf(9)).toBe('urn:outer'); // f 回到 outer
  });

  it('开始与结束事件携带相同的 prefix/local/uri', () => {
    const doc = '<p:a xmlns:p="urn:p"><p:b/></p:a>';
    const recs = parse(doc);
    expect(recs[0].name).toEqual({ prefix: 'p', local: 'a', uri: 'urn:p' });
    expect(recs.at(-1)!.name).toEqual({ prefix: 'p', local: 'a', uri: 'urn:p' });
  });

  it('无前缀属性不属于任何命名空间，而无前缀元素属于默认命名空间', () => {
    const doc = '<a xmlns="urn:a" x="1" xmlns:p="urn:p" p:y="2"/>';
    const recs = parse(doc);
    const a = recs[0];
    expect(a.name.uri).toBe('urn:a');
    const x = a.attrs!.find((z) => z.local === 'x')!;
    expect(x.prefix).toBe('');
    expect(x.uri).toBe('');
    const y = a.attrs!.find((z) => z.local === 'y')!;
    expect(y.prefix).toBe('p');
    expect(y.uri).toBe('urn:p');
  });

  it('属性上的默认命名空间声明不影响该元素其它无前缀属性', () => {
    const doc = '<a xmlns="urn:a" xmlns:p="urn:p" w="0" p:w="1"/>';
    const recs = parse(doc);
    const ws = recs[0].attrs!.filter((z) => z.local === 'w');
    expect(ws.length).toBe(2);
    expect(ws.find((z) => z.prefix === '')!.uri).toBe('');
    expect(ws.find((z) => z.prefix === 'p')!.uri).toBe('urn:p');
  });
});

describe('重复属性（按 URI + 本地名判定）', () => {
  it('同标签上不同前缀但解析到同一 URI+本地名，算重复属性', () => {
    const doc = '<a xmlns:p="urn:x" xmlns:q="urn:x" p:z="1" q:z="2"/>';
    expect(() => parse(doc)).toThrowError(/重复属性/);
  });

  it('同词法名重复算重复；前缀不同但名字不同不算', () => {
    expect(() => parse('<a x="1" x="2"/>')).toThrowError(/重复/);
    // 无前缀 x（无 URI）与 p:x（有 URI）是两个不同属性。
    expect(() => parse('<a x="1" xmlns:p="u" p:x="2"/>')).not.toThrow();
  });

  it('默认命名空间不同不影响无前缀属性（依然无 URI，因此同名才冲突）', () => {
    expect(() => parse('<a xmlns="u1" xmlns:p="u1" x="1" p:x="2"/>')).not.toThrow();
  });
});

describe('xml / xmlns 保留前缀', () => {
  it('xml 前缀恒绑定保留 URI，无需声明', () => {
    const recs = parse('<a xml:lang="zh"/>');
    const attr = recs[0].attrs![0];
    expect(attr.prefix).toBe('xml');
    expect(attr.local).toBe('lang');
    expect(attr.uri).toBe(XML_NS);
  });

  it('允许把 xml 显式声明到保留 URI', () => {
    expect(() => parse('<a xmlns:xml="http://www.w3.org/XML/1998/namespace" xml:space="preserve"/>')).not.toThrow();
  });

  it('不能把 xml 前缀绑到别的 URI', () => {
    expect(() => parse('<a xmlns:xml="http://evil" xml:x="1"/>')).toThrowError(/xml/);
  });

  it('不能拿 xmlns 当前缀绑定或出现在元素名里', () => {
    expect(() => parse('<a xmlns:xmlns="u"/>')).toThrowError(/xmlns/);
    expect(() => parse('<xmlns:a/>')).toThrowError(/xmlns/);
  });

  it('xmlns 属性解析到保留 URI', () => {
    const doc = '<a xmlns:p="u" xmlns="v"/>';
    // xmlns 声明不会作为普通属性下发；这里只确认解析正常。
    expect(() => parse(doc)).not.toThrow();
    expect(XMLNS_NS).toBe('http://www.w3.org/2000/xmlns/');
  });

  it('非空前缀不能解绑为空 URI', () => {
    expect(() => parse('<a xmlns:p=""/>')).toThrowError(/不能被解绑/);
  });

  it('使用未声明的前缀（元素/属性）报错，且切块后同样报错', () => {
    expect(() => parse('<a p:x="1"/>')).toThrowError(/未声明/);
    expect(() => parse('<a xmlns:p="u" p:x="1"/>')).not.toThrow(); // 声明在前
    expect(() => parse('<a p:x="1"/>')).toThrowError(/未声明/);
    const doc = '<a xmlns:p="u"><b q:x="1"/></a>';
    // 切碎到足以把未声明前缀跨块，切块覆盖整份文档
    expect(() => parse(doc, [7, 6, 5, 6, 6])).toThrowError(/未声明/);
  });

  it('非法限定名：多个冒号、空本地名、空前缀', () => {
    expect(() => parse('<a p:q:r="1" xmlns:p="u"/>')).toThrowError(/非法的限定名/);
    expect(() => parse('<p::a xmlns:p="u"/>')).toThrowError(/非法的限定名/);
    expect(() => parse('<:a/>')).toThrowError(/非法|名称|冒号/);
    expect(() => parse('<a :x="1"/>')).toThrowError();
  });

  it('保留命名空间 URI 不能被其它前缀/默认命名空间绑定', () => {
    expect(() => parse('<a xmlns:z="http://www.w3.org/2000/xmlns/"/>')).toThrowError(/xmlns/);
    expect(() => parse('<a xmlns:z="http://www.w3.org/XML/1998/namespace"/>')).toThrowError(/xml/);
    expect(() => parse('<a xmlns="http://www.w3.org/2000/xmlns/"/>')).toThrowError(/xmlns/);
  });
});

describe('命名空间与切块无关', () => {
  it('深层嵌套 + 反复重声明，逐字符切块结果一致', () => {
    const doc =
      '<a xmlns="u0" xmlns:x="ux">' +
      '<x:b xmlns="u1"><c xmlns="" x:d="1"><e xmlns="u2"/></c></x:b>' +
      '<f/>' +
      '</a>';
    const whole = parse(doc);
    const u8 = new TextEncoder().encode(doc);
    const byByte = (() => {
      const out: Rec[] = [];
      const p = new StreamingXmlParser({
        events: {
          startElement: (name, attrs) => out.push({ type: 's', name, attrs }),
          endElement: (name) => out.push({ type: 'e', name }),
          text() {},
          cdata() {},
          comment() {},
          processingInstruction() {},
        },
      });
      for (let i = 0; i < u8.length; i++) p.write(u8.subarray(i, i + 1));
      p.end();
      return out;
    })();
    expect(byByte.map((r) => ({ t: r.type, q: `${r.name.prefix}:${r.name.local}@${r.name.uri}` }))).toEqual(
      whole.map((r) => ({ t: r.type, q: `${r.name.prefix}:${r.name.local}@${r.name.uri}` })),
    );
  });
});
