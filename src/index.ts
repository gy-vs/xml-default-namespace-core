/**
 * 流式 XML 解析库入口。
 *
 * 典型用法：
 *
 * ```ts
 * import { StreamingXmlParser, type SaxEvents } from './index.js';
 *
 * const events: SaxEvents = {
 *   startElement(name, attrs) { ... },
 *   endElement(name) { ... },
 *   text(chunk) { ... },
 *   cdata(chunk) { ... },
 *   comment(text) { ... },
 *   processingInstruction(target, data) { ... },
 * };
 * const parser = new StreamingXmlParser({ events });
 * socket.on('data', (buf) => parser.write(buf));
 * socket.on('end', () => parser.end());
 * ```
 *
 * - write() 接受 Uint8Array（按 UTF-8 严格解码）或字符串，可在任意边界切块，
 *   包括标签中间、属性值中间、多字节字符中间、CDATA 结束符中间。
 * - 出错后调用 reset() 即可在同一实例上解析下一份文档，前一份的状态不会残留。
 */

export {
  StreamingXmlParser,
  XmlParseError,
  type ParserOptions,
  type SaxEvents,
} from './parser.js';
export {
  NamespaceContext,
  type QName,
  type RawAttribute,
  type ResolvedAttribute,
} from './namespaces.js';
export {
  XML_NS,
  XMLNS_NS,
  isXmlChar,
  isS,
  isNameStartChar,
  isNameChar,
  validateName,
  decodeReference,
} from './chars.js';
