# xml-stream-core

边收边解析的命名空间感知流式 XML 库（TypeScript）。面向网关推送报文：数据块可以在
**任意位置**切开——标签中间、属性值中间、多字节 UTF-8 字节中间、CDATA 结束符
`]]>` 中间——解析结果与切块方式完全无关。

```sh
npm install
npm test      # vitest
npm run build # tsc -> dist/
```

## 用法

```ts
import { StreamingXmlParser, type SaxEvents } from './dist/index.js';

const events: SaxEvents = {
  startElement(name, attributes) {
    // name: { prefix, local, uri }
    // attributes: [{ prefix, local, uri, value }]
  },
  endElement(name) {},
  text(chunk) {},        // 大文本按固定大小分段回调
  cdata(chunk) {},
  comment(text) {},
  processingInstruction(target, data) {},
};

const parser = new StreamingXmlParser({ events, segmentSize: 65536 });

socket.on('data', (buf: Buffer) => parser.write(buf)); // 也支持字符串
socket.on('end', () => parser.end());
```

- `write()` 接受 `Uint8Array`（严格 UTF-8）或 `string`；会自动剥离文档头 BOM、
  规范化 CR/CRLF 为 LF。
- 文本/CDATA 按 **segmentSize（默认 64KiB，按 UTF-16 代码单元）定长分段**回调，
  边界只取决于数据内容，与切块无关；同一次运行内各段拼接后逐字符等于原文。
  解析器自身只保留常数大小的尾部与一个未满段，内存不随文档总大小增长。
- 出错抛 `XmlParseError`（含 `line` / `column`）。出错后调用 `reset()` 即可在同一
  实例上解析下一份文档，前一份的所有状态（含未读完的多字节序列）都不会残留。

## 解析规则要点

- 命名空间：默认命名空间内层重声明 / `xmlns=""` 清空 / 兄弟节点恢复外层；
  无前缀属性不属于任何命名空间；`xml`、`xmlns` 保留 URI 规则按
  Namespaces in XML 1.0 强校验；属性按 **(URI, local)** 去重。
- 实体只接受五个预定义实体（`lt gt amp apos quot`）与数字字符引用；
  数字引用指向非法码位（含代理码点）报错。
- 支持 DOCTYPE 但拒绝内部子集中的 `ENTITY` 声明与参数实体引用
  （不碰实体膨胀类问题）。
- 支持 `<?xml ...?>` 声明（仅版本 1.x、仅 UTF-8 编码声明）。
