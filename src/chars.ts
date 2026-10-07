// XML 1.0 字符产生式、Name 校验、实体引用解码。
// 全部按 XML 1.0 (Fifth Edition) 与 Namespaces in XML 1.0 实现。

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF] */
export function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** XML 空白 S ::= (#x20 | #x9 | #xD | #xA)+。喂入解析器前 CR 已规范化为 \n。 */
export function isS(code: number): boolean {
  return code === 0x20 || code === 0x9 || code === 0xd || code === 0xa;
}

export function isNameStartChar(code: number): boolean {
  return (
    code === 0x3a || // :
    code === 0x5f || // _
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0xc0 && code <= 0xd6) ||
    (code >= 0xd8 && code <= 0xf6) ||
    (code >= 0xf8 && code <= 0x2ff) ||
    (code >= 0x370 && code <= 0x37d) ||
    (code >= 0x37f && code <= 0x1fff) ||
    (code >= 0x200c && code <= 0x200d) ||
    (code >= 0x2070 && code <= 0x218f) ||
    (code >= 0x2c00 && code <= 0x2fef) ||
    (code >= 0x3001 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfdcf) ||
    (code >= 0xfdf0 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0xeffff)
  );
}

export function isNameChar(code: number): boolean {
  return (
    isNameStartChar(code) ||
    code === 0x2d || // -
    code === 0x2e || // .
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0xb7 ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x203f && code <= 0x2040)
  );
}

/**
 * 校验 XML Name。allowColon 为 true 时用于整段 QName 原始词法
 * （冒号能出现几处、前后是否非空由 QName 拆分逻辑负责）。
 */
export function validateName(raw: string, allowColon: boolean): void {
  if (raw.length === 0) {
    throw new Error('名称为空');
  }
  const first = raw.codePointAt(0)!;
  if (!isNameStartChar(first) || (!allowColon && first === 0x3a)) {
    throw new Error(`非法的名称起始字符: "${raw[0]}"`);
  }
  let i = first > 0xffff ? 2 : 1;
  for (; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!isNameChar(c) || (!allowColon && c === 0x3a)) {
      throw new Error(`名称中含有非法字符: "${raw[i]}"`);
    }
  }
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  apos: "'",
  quot: '"',
};

/**
 * 解码 & 与 ; 之间的引用内容。
 * 只接受五个预定义实体与数字字符引用，其余一律报错
 * （DOCTYPE 内部实体声明在扫描 DOCTYPE 时就已拒绝）。
 */
export function decodeReference(raw: string): string {
  if (raw.length === 0) {
    throw new Error('空的实体引用');
  }
  if (raw[0] === '#') {
    let cp: number;
    if (raw[1] === 'x' || raw[1] === 'X') {
      const hex = raw.slice(2);
      if (hex.length === 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error(`非法的十六进制字符引用: &#${raw.slice(1)};`);
      }
      cp = parseInt(hex, 16);
    } else {
      const dec = raw.slice(1);
      if (dec.length === 0 || !/^[0-9]+$/.test(dec)) {
        throw new Error(`非法的十进制字符引用: &#${dec};`);
      }
      cp = parseInt(dec, 10);
    }
    if (cp > 0x10ffff || !isXmlChar(cp)) {
      throw new Error(`字符引用指向非法字符: &${raw};`);
    }
    return String.fromCodePoint(cp);
  }
  const predefined = PREDEFINED_ENTITIES[raw];
  if (predefined !== undefined) {
    return predefined;
  }
  throw new Error(
    `不支持的实体引用 "&${raw};"，仅允许 lt/gt/amp/apos/quot 与数字字符引用`,
  );
}
