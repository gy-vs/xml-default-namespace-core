import { decodeReference, isNameChar, isNameStartChar, isS, validateName } from './chars.js';
import {
  NamespaceContext,
  type QName,
  type RawAttribute,
  type ResolvedAttribute,
} from './namespaces.js';

/** 文本/CDATA 分段事件的默认最大长度（UTF-16 代码单元）。 */
const DEFAULT_SEGMENT = 1 << 16;

const NEED_MORE = -1;

/** 正文（文本、CDATA、注释、PI、属性值）中禁止出现的字符。 */
const ILLEGAL_DATA = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/;
/** 文档头尾允许存在的可忽略空白（喂入前 CR/CRLF 已规范化为 \n）。 */
const ONLY_S = /^[ \t\n]*$/;
const REFERENCE = /^(?:[a-zA-Z_][\w.-]*|#\d+|#x[0-9a-fA-F]+)$/;
const ENTITY_IN_SUBSET = /^<!ENTITY(?:[ \t\n]|$)/;
const MARKUP_IN_SUBSET = /^<!(?:ELEMENT|ATTLIST|NOTATION)\b/;

export class XmlParseError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(line: number, column: number, reason: string) {
    super(`XML 解析错误（第 ${line} 行第 ${column} 列）：${reason}`);
    this.name = 'XmlParseError';
    this.line = line;
    this.column = column;
  }
}

export interface SaxEvents {
  startElement(name: QName, attributes: ResolvedAttribute[]): void;
  endElement(name: QName): void;
  /** 文本节点的一段；同一次文本运行内各段拼起来逐字符等于解码后的原文。 */
  text(chunk: string): void;
  /** CDATA 节内容的一段（不含 <![CDATA[ 与 ]]>）。 */
  cdata(chunk: string): void;
  comment(text: string): void;
  processingInstruction(target: string, data: string): void;
}

export interface ParserOptions {
  events: SaxEvents;
  /** 文本/CDATA 单段事件的最大 UTF-16 长度，默认 65536；只由数据内容决定，与喂入切块无关。 */
  segmentSize?: number;
}

type Phase = 'prolog' | 'body' | 'epilog';
type State =
  | 'text'
  | 'markupOpen'
  | 'declOpen'
  | 'doctype'
  | 'tagName'
  | 'etagName'
  | 'tagBody'
  | 'comment'
  | 'cdata'
  | 'piTarget'
  | 'piBody';

// ---------------------------------------------------------------------------
// 输入规范化：字节走严格 UTF-8（fatal TextDecoder），字符串校验代理对。
// 统一负责 BOM 剥离（仅文档绝对开头）与 CR/CRLF -> \n（含跨块折叠）。
// ---------------------------------------------------------------------------

class Input {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private crPending = false;
  private bomDone = false;
  /** 字符串输入时跨块挂起的高代理项（切块可以切在代理对中间）。 */
  private hiSurrogate = 0;

  reset(): void {
    this.decoder = new TextDecoder('utf-8', { fatal: true });
    this.crPending = false;
    this.bomDone = false;
    this.hiSurrogate = 0;
  }

  feedBytes(chunk: Uint8Array, final: boolean): string {
    let s: string;
    try {
      s = this.decoder.decode(chunk, { stream: !final });
    } catch {
      throw new TypeError('非法的 UTF-8 字节序列');
    }
    if (final) {
      try {
        s += this.decoder.decode(new Uint8Array(0));
      } catch {
        throw new TypeError('文档在残缺的 UTF-8 多字节序列中结束');
      }
    }
    return this.normalize(s);
  }

  feedString(chunk: string): string {
    // 拼接上一块末尾挂起的高代理项（切块可能落在代理对中间）。
    let s = chunk;
    if (this.hiSurrogate !== 0) {
      if (s.length === 0) return '';
      const low = s.charCodeAt(0);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new TypeError('残缺的 UTF-16 代理对');
      }
      s = String.fromCharCode(this.hiSurrogate) + s;
      this.hiSurrogate = 0;
    }
    // 末字符若为高代理项，挂起等下一块。
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.hiSurrogate = last;
      s = s.slice(0, -1);
    }
    for (let i = 0; i < s.length; i++) {
      const cu = s.charCodeAt(i);
      if (cu >= 0xd800 && cu <= 0xdbff) {
        if (!(s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) {
          throw new TypeError('残缺的 UTF-16 代理对');
        }
        i++;
      } else if (cu >= 0xdc00 && cu <= 0xdfff) {
        throw new TypeError('残缺的 UTF-16 代理对');
      }
    }
    return this.normalize(s);
  }

  /** 文档结束时挂起的 CR 需要补出一个换行。 */
  finish(): string {
    if (this.hiSurrogate !== 0) {
      this.hiSurrogate = 0;
      throw new TypeError('文档在残缺的 UTF-16 代理对中结束');
    }
    if (this.crPending) {
      this.crPending = false;
      return '\n';
    }
    return '';
  }

  private normalize(s: string): string {
    if (!this.bomDone) {
      if (s.length > 0) {
        this.bomDone = true;
        if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      }
    }
    if (s.indexOf('\r') === -1 && !this.crPending) return s;

    let out = '';
    let i = 0;
    if (this.crPending) {
      this.crPending = false;
      if (s.charCodeAt(0) === 0x0a) {
        s = s.slice(1);
      }
      out += '\n';
    }
    while (i < s.length) {
      if (s.charCodeAt(i) !== 0x0d) {
        const next = s.indexOf('\r', i + 1);
        const end = next === -1 ? s.length : next;
        out += s.slice(i, end);
        i = end;
        continue;
      }
      if (i + 1 < s.length) {
        out += '\n';
        i += s.charCodeAt(i + 1) === 0x0a ? 2 : 1;
      } else {
        // CR 恰好落在块尾：先不输出，等下一块确认是不是 CRLF。
        this.crPending = true;
        i++;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 解析器主体
// ---------------------------------------------------------------------------

export class StreamingXmlParser {
  private readonly events: SaxEvents;
  private readonly segmentSize: number;
  private readonly input = new Input();
  private readonly ns = new NamespaceContext();

  /** 尚未完全消费、需要下次重扫的尾部字符；line/column 对应其首字符。 */
  private pending = '';
  private line = 1;
  private column = 1;

  private phase: Phase = 'prolog';
  private state: State = 'text';
  private readonly stack: QName[] = [];
  private rootSeen = false;
  private doctypeSeen = false;
  /** xml 声明之前是否已经出现过注释/PI/DOCTYPE */
  private preludeContentSeen = false;
  private finished = false;
  private errored = false;

  // 文本运行分段：缓冲只在攒满 segmentSize 时吐出整段，运行（run）结束再吐余段。
  // 因此事件边界只取决于数据内容，与 write() 的切块方式完全无关；
  // 缓冲上界恒为 segmentSize + 单块残余，不随文档总大小增长。
  private textBuf: string[] = [];
  private textBufLen = 0;
  private cdataBuf: string[] = [];
  private cdataBufLen = 0;

  // 元素标签
  private nameBuf = '';
  private tagMode: 'open' | 'close' = 'open';
  private attrs: RawAttribute[] = [];
  private attrPhase: 'name' | 'afterName' | 'eq' | 'beforeValue' | 'value' = 'name';
  private attrName = '';
  private attrValue: string[] = [];
  private attrQuote = 0;

  // 注释 / PI / 声明
  private pieces: string[] = [];
  private piTarget = '';
  private piBody: string[] = [];
  private piHasContent = false;
  private commentBackDoctype = false;
  private doctype: {
    mode: 'beforeName' | 'name' | 'body' | 'subset' | 'afterSubset';
    name: string;
    quote: number;
  } = { mode: 'beforeName', name: '', quote: 0 };

  private retainAt = 0;

  constructor(options: ParserOptions) {
    this.events = options.events;
    const seg = options.segmentSize ?? DEFAULT_SEGMENT;
    if (!Number.isInteger(seg) || seg < 16) {
      throw new Error('segmentSize 必须是不小于 16 的整数');
    }
    this.segmentSize = seg;
  }

  get currentLine(): number {
    return this.line;
  }

  get currentColumn(): number {
    return this.column;
  }

  /** 喂入一块数据，支持 Uint8Array（UTF-8）或字符串。块边界可以落在任意位置。 */
  write(chunk: Uint8Array | string): this {
    if (this.finished) {
      throw new XmlParseError(this.line, this.column, '文档已结束，不能继续喂入数据');
    }
    if (this.errored) {
      throw new XmlParseError(
        this.line,
        this.column,
        '解析器已处于错误状态，请调用 reset() 后再解析下一份文档',
      );
    }
    let decoded: string;
    try {
      decoded =
        typeof chunk === 'string'
          ? this.input.feedString(chunk)
          : this.input.feedBytes(chunk, false);
    } catch (e) {
      this.errored = true;
      throw new XmlParseError(this.line, this.column, (e as Error).message);
    }
    if (decoded.length > 0) {
      try {
        this.feed(decoded);
      } catch (e) {
        this.errored = true;
        throw e;
      }
    }
    return this;
  }

  /** 声明文档结束。若仍有未闭合的结构则抛错。 */
  end(): this {
    if (this.finished) return this;
    try {
      // 逼出跨块残留的 UTF-8 序列；字符串输入时这里只会得到空串。
      const tail = this.input.feedBytes(new Uint8Array(0), true) + this.input.finish();
      if (tail.length > 0) this.feed(tail);
    } catch (e) {
      this.errored = true;
      if (e instanceof XmlParseError) throw e;
      throw new XmlParseError(this.line, this.column, (e as Error).message);
    }
    if (this.state !== 'text' || this.pending.length > 0) {
      this.errored = true;
      throw new XmlParseError(
        this.line,
        this.column,
        '文档在结构未闭合时结束（标签、注释、CDATA、处理指令、DOCTYPE 或引用未终止）',
      );
    }
    // 输出/校验尾部挂着的最后一段文本（epilog 只允许空白）。
    this.closeTextRun();
    if (!this.rootSeen) {
      this.errored = true;
      throw new XmlParseError(this.line, this.column, '文档缺少根元素');
    }
    if (this.stack.length !== 0) {
      this.errored = true;
      const t = this.stack[this.stack.length - 1];
      throw new XmlParseError(this.line, this.column, `元素 "${qname(t)}" 没有闭合标签`);
    }
    this.finished = true;
    return this;
  }

  /**
   * 复位全部解析状态。出错后调用，同一实例可继续解析下一份文档，
   * 前一份文档的任何残留（含未读完的多字节序列）都不会带过来。
   */
  reset(): this {
    this.input.reset();
    this.ns.reset();
    this.pending = '';
    this.line = 1;
    this.column = 1;
    this.phase = 'prolog';
    this.state = 'text';
    this.stack.length = 0;
    this.rootSeen = false;
    this.doctypeSeen = false;
    this.preludeContentSeen = false;
    this.finished = false;
    this.errored = false;
    this.textBuf.length = 0;
    this.textBufLen = 0;
    this.cdataBuf.length = 0;
    this.cdataBufLen = 0;
    this.nameBuf = '';
    this.tagMode = 'open';
    this.attrs.length = 0;
    this.attrPhase = 'name';
    this.attrName = '';
    this.attrValue.length = 0;
    this.attrQuote = 0;
    this.pieces.length = 0;
    this.piTarget = '';
    this.piBody.length = 0;
    this.piHasContent = false;
    this.commentBackDoctype = false;
    this.doctype = { mode: 'beforeName', name: '', quote: 0 };
    this.retainAt = 0;
    return this;
  }

  // -------------------------------------------------------------------------
  // 主驱动。约定：扫描函数返回下次起点；返回 NEED_MORE 时 retainAt 之前的
  // 内容必须已被消费（输出或进入各类缓冲），retainAt 起整体保留到 pending。
  // -------------------------------------------------------------------------

  private feed(chunk: string): void {
    const data = this.pending + chunk;
    const n = data.length;
    let i = 0;
    while (i < n) {
      switch (this.state) {
        case 'text': i = this.scanText(data, i); break;
        case 'markupOpen': i = this.scanMarkupOpen(data, i); break;
        case 'declOpen': i = this.scanDeclOpen(data, i); break;
        case 'doctype': i = this.scanDoctype(data, i); break;
        case 'tagName': i = this.scanTagName(data, i); break;
        case 'etagName': i = this.scanTagName(data, i); break;
        case 'tagBody': i = this.scanTagBody(data, i); break;
        case 'comment': i = this.scanComment(data, i); break;
        case 'cdata': i = this.scanCdata(data, i); break;
        case 'piTarget': i = this.scanPiTarget(data, i); break;
        case 'piBody': i = this.scanPiBody(data, i); break;
      }
      if (i === NEED_MORE) {
        this.advancePosition(data, this.retainAt);
        this.pending = data.slice(this.retainAt);
        return;
      }
    }
    this.advancePosition(data, n);
    this.pending = '';
  }

  private advancePosition(data: string, at: number): void {
    const d = delta(data, at);
    this.line += d.line - 1;
    this.column = d.line === 1 ? this.column + d.column - 1 : d.column;
  }

  private needMore(at: number): typeof NEED_MORE {
    this.retainAt = at;
    return NEED_MORE;
  }

  private failAt(data: string, at: number, reason: string): never {
    const d = delta(data, at);
    throw new XmlParseError(
      this.line + d.line - 1,
      d.line === 1 ? this.column + d.column - 1 : d.column,
      reason,
    );
  }

  // -------------------------------------------------------------------------
  // 文本内容
  // -------------------------------------------------------------------------

  private scanText(data: string, start: number): number {
    let i = start;
    const n = data.length;
    while (i < n) {
      const lt = data.indexOf('<', i);
      const amp = data.indexOf('&', i);
      const next =
        lt === -1 ? (amp === -1 ? n : amp)
        : amp === -1 ? lt
        : Math.min(lt, amp);
      if (next > i) {
        i = this.consumeRawText(data, i, next, next === n);
        if (i === NEED_MORE) return NEED_MORE;
      }
      if (i === n) return n;
      if (i === lt) {
        // '<' 后至少要看到一个字符才能分派。
        if (i + 1 >= n) return this.needMore(i);
        this.closeTextRun(data, i);
        this.state = 'markupOpen';
        return i + 1;
      }
      // '&' 引用
      const semi = data.indexOf(';', i + 1);
      const lt2 = data.indexOf('<', i + 1);
      if (semi === -1 || (lt2 !== -1 && lt2 < semi)) {
        if (semi === -1 && (lt2 === -1 || lt2 >= n)) return this.needMore(i);
        this.failAt(data, i, '实体/字符引用没有以分号闭合，或文本中直接使用了 "&"');
      }
      const raw = data.slice(i + 1, semi);
      if (!REFERENCE.test(raw)) {
        this.failAt(data, i, `非法的引用 "&${raw};"，仅允许五个预定义实体与数字字符引用`);
      }
      let decoded: string;
      try {
        decoded = decodeReference(raw);
      } catch (e) {
        this.failAt(data, i, (e as Error).message);
      }
      // 解码出的字符数量很小（数字字符引用最多 2 个 UTF-16 单元），
      // 直接追加到运行缓冲；引用解码出的 ']' 不参与词法层的 "]]>" 检查。
      this.acceptText(data, i, decoded);
      i = semi + 1;
    }
    return n;
  }

  /**
   * 消费 data[a:b] 这段原始文本。
   * - 若 atChunkEnd（b 是块尾、下一字符未知），末尾最多 2 个可能成为
   *   "]]>" 前缀的 ']' 随 pending 原样重扫（重扫部分未发送过，不会重复）；
   * - 否则下一字符是 '&' 或 '<'，不可能补成 "]]>"，整段安全消费。
   */
  private consumeRawText(data: string, a: number, b: number, atChunkEnd: boolean): number {
    let cut = b;
    if (atChunkEnd) {
      let trailing = 0;
      while (trailing < 2 && cut > a && data[cut - 1] === ']') {
        cut--;
        trailing++;
      }
      if (trailing > 0) {
        if (cut > a) this.acceptText(data, a, data.slice(a, cut));
        return this.needMore(cut);
      }
    }
    const s = data.slice(a, b);
    if (s.includes(']]>')) {
      this.failAt(data, a + s.indexOf(']]>'), '文本内容中不允许出现 "]]>"');
    }
    this.acceptText(data, a, s);
    return b;
  }

  /** 把一段文本接入运行缓冲（校验非法字符；prolog/epilog 只接受空白）。 */
  private acceptText(data: string, at: number, s: string): void {
    if (s.length === 0) return;
    const bad = ILLEGAL_DATA.exec(s);
    if (bad) this.failAt(data, at + bad.index, '文本中含有非法 XML 字符');
    if (this.phase === 'body') {
      this.appendRun(s, false);
    } else if (!ONLY_S.test(s)) {
      this.failAt(
        data,
        at,
        this.phase === 'prolog'
          ? '根元素之前出现了非空白文本'
          : '根元素之后出现了非空白文本',
      );
    }
  }

  /**
   * 一次文本运行结束（遇到标记）或文档结束：把分段缓冲里的余段
   * 作为最后一个 text 事件吐出。prolog/epilog 里只会有空白，直接丢弃。
   */
  private closeTextRun(data?: string, at?: number): void {
    if (this.textBufLen > 0) {
      if (this.phase === 'body') {
        this.events.text(this.textBuf.join(''));
      } else if (data !== undefined) {
        this.failAt(
          data,
          at ?? 0,
          this.phase === 'prolog'
            ? '根元素之前出现了非空白文本'
            : '根元素之后出现了非空白文本',
        );
      }
      this.textBuf.length = 0;
      this.textBufLen = 0;
    }
  }

  /**
   * 往文本/CDATA 运行缓冲追加内容；攒满 segmentSize 就立刻吐出整段。
   *
   * 分段严格按 UTF-16 代码单元定长切分：不避让代理对，允许一个代理对落在
   * 两段的交界处。这样分段边界只由内容位置决定，与 write() 的切块完全无关；
   * 调用方把同一次运行的各段拼起来即可逐字符（含跨段代理对）还原原文。
   */
  private appendRun(s: string, isCdata: boolean): void {
    const buf = isCdata ? this.cdataBuf : this.textBuf;
    let len = isCdata ? this.cdataBufLen : this.textBufLen;
    let offset = 0;
    const emit = isCdata ? this.events.cdata : this.events.text;
    while (this.segmentSize - len <= s.length - offset) {
      if (len === 0 && offset === 0) {
        // 单块就至少有一整段：直接从 s 切，避免 join 大缓冲。
        emit.call(this.events, s.slice(0, this.segmentSize));
        offset = this.segmentSize;
      } else {
        const take = this.segmentSize - len;
        buf.push(s.slice(offset, offset + take));
        offset += take;
        emit.call(this.events, buf.join(''));
        buf.length = 0;
        len = 0;
      }
    }
    if (offset < s.length) {
      buf.push(s.slice(offset));
      len += s.length - offset;
    }
    if (isCdata) this.cdataBufLen = len;
    else this.textBufLen = len;
  }

  // -------------------------------------------------------------------------
  // '<' 之后的分派，以及 '<!' 声明
  // -------------------------------------------------------------------------

  private scanMarkupOpen(data: string, i: number): number {
    const c = data[i];
    if (c === '/') {
      if (this.phase !== 'body') this.failAt(data, i, '文档头尾部不允许出现结束标签');
      this.state = 'etagName';
      this.nameBuf = '';
      this.tagMode = 'close';
      return i + 1;
    }
    if (c === '?') {
      this.state = 'piTarget';
      this.piTarget = '';
      this.piBody = [];
      this.piHasContent = false;
      return i + 1;
    }
    if (c === '!') {
      this.state = 'declOpen';
      return i + 1;
    }
    const code = c.charCodeAt(0);
    if (isNameStartChar(code)) {
      if (c === ':') this.failAt(data, i, '元素名不能以冒号开头');
      this.state = 'tagName';
      this.nameBuf = '';
      this.tagMode = 'open';
      return i; // 重新消费该字符
    }
    this.failAt(data, i, `非法的标记起始字符 "${c}"`);
  }

  /**
   * 当前位置是 '!' 之后的第一个字符。数据不足时必须保持 declOpen 状态、
   * 从本状态起点（'!' 后首字符）整体重扫——绝不能退回 text，否则已经越过
   * '<' 的声明首字符（如单独到达的 '['）会被当成普通文本内容。
   */
  private scanDeclOpen(data: string, start: number): number {
    const n = data.length;
    const b = start;
    // 注释：--
    if (data[b] === '-') {
      if (b + 1 >= n) return this.needMore(b);
      if (data[b + 1] !== '-') this.failAt(data, b, '非法声明：期望 "<!--"');
      this.beginComment(false);
      return b + 2;
    }
    // CDATA：[CDATA[
    if (data[b] === '[') {
      const want = '[CDATA[';
      if (b + want.length > n) return this.needMore(b);
      if (data.slice(b, b + want.length) !== want) {
        this.failAt(data, b, '非法声明：期望 "<![CDATA["');
      }
      if (this.phase !== 'body') this.failAt(data, b, 'CDATA 节只能出现在元素内容中');
      this.state = 'cdata';
      this.cdataBuf.length = 0;
      this.cdataBufLen = 0;
      return b + want.length;
    }
    // 读声明名到空白 / '>' / '['
    let j = b;
    while (j < n) {
      const ch = data[j];
      if (isS(ch.charCodeAt(0)) || ch === '>' || ch === '[') break;
      j++;
    }
    if (j === n) return this.needMore(b);
    const keyword = data.slice(b, j);
    if (keyword !== 'DOCTYPE') {
      this.failAt(data, b, `不支持的声明 "<!${keyword}"（只允许注释、CDATA 与 DOCTYPE）`);
    }
    if (this.phase !== 'prolog' || this.rootSeen || this.doctypeSeen) {
      this.failAt(data, b, 'DOCTYPE 只能在文档头部、根元素之前出现一次');
    }
    if (data[j] === '[') this.failAt(data, j, '非法的 DOCTYPE 语法');
    if (data[j] === '>') this.failAt(data, j, 'DOCTYPE 缺少根元素名');
    this.doctypeSeen = true;
    this.doctype = { mode: 'beforeName', name: '', quote: 0 };
    this.state = 'doctype';
    return j;
  }

  // -------------------------------------------------------------------------
  // DOCTYPE：整体跳过。内部子集中拒绝实体声明与参数实体引用。
  // -------------------------------------------------------------------------

  private scanDoctype(data: string, start: number): number {
    let i = start;
    const n = data.length;
    const d = this.doctype;
    while (i < n) {
      const ch = data[i];
      if (d.mode === 'beforeName') {
        if (isS(ch.charCodeAt(0))) {
          i++;
          continue;
        }
        d.mode = 'name';
        d.name = '';
      }
      if (d.mode === 'name') {
        if (isS(ch.charCodeAt(0))) {
          validateName(d.name, true);
          d.name = '';
          d.mode = 'body';
          i++;
          continue;
        }
        if (ch === '[' || ch === '>') {
          validateName(d.name, true);
          d.name = '';
          if (ch === '[') {
            d.mode = 'subset';
            i++;
            continue;
          }
          return this.finishDoctype(i + 1);
        }
        d.name += ch;
        i++;
        continue;
      }
      if (d.mode === 'afterSubset') {
        if (isS(ch.charCodeAt(0))) {
          i++;
          continue;
        }
        if (ch === '>') return this.finishDoctype(i + 1);
        this.failAt(data, i, '非法的 DOCTYPE 语法：内部子集之后期望 ">"');
      }
      // body / subset：引号内原样跳过
      if (d.quote !== 0) {
        if (ch === String.fromCharCode(d.quote)) d.quote = 0;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        d.quote = ch.charCodeAt(0);
        i++;
        continue;
      }
      if (d.mode === 'body') {
        if (ch === '[') {
          d.mode = 'subset';
          i++;
          continue;
        }
        if (ch === '>') return this.finishDoctype(i + 1);
        if (ch === '<') this.failAt(data, i, 'DOCTYPE 外部 ID 中不允许出现标记');
        i++;
        continue;
      }
      // subset
      if (ch === '%') this.failAt(data, i, 'DOCTYPE 内部子集中不允许参数实体引用');
      if (ch === ']') {
        d.mode = 'afterSubset';
        i++;
        continue;
      }
      if (ch === '<') {
        const head = data.slice(i, i + 9);
        if (head.length < 9) return this.needMore(i);
        if (ENTITY_IN_SUBSET.test(head)) {
          this.failAt(data, i, 'DOCTYPE 内部子集不允许声明实体（防止实体膨胀类问题）');
        }
        if (MARKUP_IN_SUBSET.test(head)) {
          this.failAt(data, i, 'DOCTYPE 内部子集中只允许空白与注释');
        }
        if (data.startsWith('<!--', i)) {
          this.beginComment(true);
          return i + 4;
        }
        this.failAt(data, i, 'DOCTYPE 内部子集中含有不支持的声明');
      }
      i++;
    }
    return this.needMore(start);
  }

  private finishDoctype(after: number): number {
    this.doctype = { mode: 'beforeName', name: '', quote: 0 };
    this.state = 'text';
    this.preludeContentSeen = true;
    return after;
  }

  // -------------------------------------------------------------------------
  // 开始/结束标签
  // -------------------------------------------------------------------------

  private scanTagName(data: string, start: number): number {
    let i = start;
    const n = data.length;
    while (i < n) {
      const ch = data[i];
      if (isNameChar(ch.charCodeAt(0))) {
        this.nameBuf += ch;
        i++;
        continue;
      }
      if (this.nameBuf.length === 0) {
        this.failAt(
          data,
          i,
          this.tagMode === 'close' ? '结束标签缺少元素名' : '开始标签缺少元素名',
        );
      }
      validateName(this.nameBuf, true);
      if (this.tagMode === 'close' && !isS(ch.charCodeAt(0)) && ch !== '>') {
        this.failAt(data, i, '结束标签中元素名后只允许空白与 ">"');
      }
      this.state = 'tagBody';
      this.attrs = [];
      this.attrPhase = 'name';
      return i; // 分隔符交给 tagBody 重新消费
    }
    return n; // 名字跨块：字符已进 nameBuf，无需重扫
  }

  private scanTagBody(data: string, start: number): number {
    let i = start;
    const n = data.length;
    while (i < n) {
      const ch = data[i];
      const code = ch.charCodeAt(0);
      switch (this.attrPhase) {
        case 'name': {
          if (isS(code)) {
            i++;
            continue;
          }
          if (ch === '>') return this.finishTag(data, i + 1);
          if (ch === '/') {
            if (this.tagMode === 'close') this.failAt(data, i, '结束标签中不允许出现 "/"');
            if (i + 1 >= n) return this.needMore(i); // '/' 被切开
            if (data[i + 1] !== '>') this.failAt(data, i, '自闭合标签必须写作 "/>"');
            return this.finishTag(data, i + 2, true);
          }
          if (this.tagMode === 'close') this.failAt(data, i, '结束标签中不允许出现属性');
          if (!isNameStartChar(code) || ch === ':') {
            this.failAt(data, i, `非法的属性名起始字符 "${ch}"`);
          }
          this.attrName = ch;
          this.attrPhase = 'afterName';
          i++;
          continue;
        }
        case 'afterName': {
          if (isNameChar(code)) {
            this.attrName += ch;
            i++;
            continue;
          }
          validateName(this.attrName, true);
          if (ch === '=') {
            this.attrPhase = 'beforeValue';
            i++;
            continue;
          }
          if (isS(code)) {
            this.attrPhase = 'eq';
            i++;
            continue;
          }
          this.failAt(data, i, `属性 "${this.attrName}" 后期望 "="`);
        }
        case 'eq': {
          if (isS(code)) {
            i++;
            continue;
          }
          if (ch === '=') {
            this.attrPhase = 'beforeValue';
            i++;
            continue;
          }
          this.failAt(data, i, `属性 "${this.attrName}" 后期望 "="`);
        }
        case 'beforeValue': {
          if (isS(code)) {
            i++;
            continue;
          }
          if (ch !== '"' && ch !== "'") {
            this.failAt(data, i, '属性值必须以引号开头');
          }
          this.attrQuote = code;
          this.attrValue = [];
          this.attrPhase = 'value';
          i++;
          continue;
        }
        case 'value': {
          const r = this.scanAttrValue(data, i);
          if (r === NEED_MORE) return r;
          i = r;
          this.attrPhase = 'name';
          continue;
        }
      }
    }
    return n;
  }

  /**
   * 属性值扫描（进入时 i 位于开引号之后）。跨块挂起有两种：
   * - 块尾普通值内容：已追加，保留点在块尾，新块续写即可；
   * - '&' 在块尾未见 ';'：'&' 之后尚未追加，从 '&' 重扫保证不重复。
   */
  /**
   * 属性值扫描（进入时 i 位于开引号之后）。返回值约定：
   * - 看到闭合引号：返回其后下标（属性完成）；
   * - 其余情况：NEED_MORE。本段已追加的普通内容/已解码引用都在保留点之前，
   *   保留点一律取"当前消费到的位置"（通常为块尾），从而下块只从新内容续写，
   *   不会重复追加或重复解码。
   */
  private scanAttrValue(data: string, start: number): number {
    const quote = String.fromCharCode(this.attrQuote);
    let i = start;
    const n = data.length;
    while (i < n) {
      const q = data.indexOf(quote, i);
      const amp = data.indexOf('&', i);
      const lt = data.indexOf('<', i);
      let next = n;
      if (q !== -1) next = Math.min(next, q);
      if (amp !== -1) next = Math.min(next, amp);
      if (lt !== -1) next = Math.min(next, lt);
      if (next < n) {
        if (next > i) this.appendAttrValue(data.slice(i, next));
        const ch = data[next];
        if (ch === quote) {
          for (const a of this.attrs) {
            if (a.name === this.attrName) this.failAt(data, next, `重复的属性 "${this.attrName}"`);
          }
          this.attrs.push({ name: this.attrName, value: this.attrValue.join('') });
          this.attrValue = [];
          return next + 1;
        }
        if (ch === '<') this.failAt(data, next, '属性值中不允许出现 "<"');
        const semi = data.indexOf(';', next + 1);
        // '&' 之后看不到 ';'：'&' 尚未追加，保留 '&' 重扫，保证不重复。
        if (semi === -1) return this.needMore(next);
        const raw = data.slice(next + 1, semi);
        if (!REFERENCE.test(raw)) this.failAt(data, next, `非法的引用 "&${raw};"`);
        try {
          this.appendAttrValue(decodeReference(raw));
        } catch (e) {
          this.failAt(data, next, (e as Error).message);
        }
        i = semi + 1;
        continue;
      }
      // 块尾恰为 '&'：不能当普通值追加（否则下块的 'amp;' 不会再解码），
      // 先输出 '&' 之前的内容，保留点放在 '&' 处整体重扫。
      if (amp !== -1 && amp === n - 1) {
        if (amp > i) this.appendAttrValue(data.slice(i, amp));
        return this.needMore(amp);
      }
      // 到块尾都是普通值内容。
      if (n > i) this.appendAttrValue(data.slice(i, n));
      return this.needMore(n);
    }
    // 引用恰好消费到块尾：保留点即块尾（pending 为空），下块续写。
    return this.needMore(n);
  }

  private appendAttrValue(s: string): void {
    if (s.length === 0) return;
    if (ILLEGAL_DATA.test(s)) {
      throw new XmlParseError(this.line, this.column, '属性值中含有非法 XML 字符');
    }
    // 按 CDATA 类型做属性值规范化：制表符与换行映射为空格。
    if (s.indexOf('\t') !== -1 || s.indexOf('\n') !== -1) {
      s = s.replace(/[\t\n]/g, ' ');
    }
    this.attrValue.push(s);
  }

  private finishTag(data: string, after: number, selfClose = false): number {
    if (this.tagMode === 'close') {
      let name: QName;
      try {
        name = this.ns.resolve(this.nameBuf);
      } catch (e) {
        this.failAt(data, after - 1, (e as Error).message);
      }
      this.ns.pop();
      const top = this.stack.pop();
      if (!top) this.failAt(data, after - 1, `结束标签 "</${qname(name)}>" 没有对应的开始标签`);
      if (top.prefix !== name.prefix || top.local !== name.local || top.uri !== name.uri) {
        this.failAt(
          data,
          after - 1,
          `结束标签 "</${qname(name)}>" 与开始标签 "<${qname(top)}>" 不匹配`,
        );
      }
      this.events.endElement(top);
      if (this.stack.length === 0) this.phase = 'epilog';
    } else {
      let resolved: { name: QName; attrs: ResolvedAttribute[] };
      try {
        resolved = this.ns.push(this.nameBuf, this.attrs);
      } catch (e) {
        this.failAt(data, after - 1, (e as Error).message);
      }
      const { name, attrs } = resolved;
      if (this.phase === 'epilog') this.failAt(data, after - 1, '根元素之后不允许再出现元素');
      this.events.startElement(name, attrs);
      this.stack.push(name);
      if (!this.rootSeen) {
        this.rootSeen = true;
        this.phase = 'body';
      }
      if (selfClose) {
        this.ns.pop();
        this.stack.pop();
        this.events.endElement(name);
        if (this.stack.length === 0) this.phase = 'epilog';
      }
    }
    this.nameBuf = '';
    this.attrs = [];
    this.attrName = '';
    this.attrValue = [];
    this.state = 'text';
    return after;
  }

  // -------------------------------------------------------------------------
  // 注释
  // -------------------------------------------------------------------------

  private beginComment(backToDoctype: boolean): void {
    this.state = 'comment';
    this.pieces = [];
    this.commentBackDoctype = backToDoctype;
  }

  private scanComment(data: string, start: number): number {
    let i = start;
    const n = data.length;
    for (;;) {
      const d = data.indexOf('--', i);
      if (d === -1) {
        // 末尾至多挂一个 '-'，其余全部进入缓冲。
        const keep = n > i && data[n - 1] === '-' ? 1 : 0;
        if (n - keep > i) this.pieces.push(data.slice(i, n - keep));
        return this.needMore(n - keep);
      }
      if (d > i) this.pieces.push(data.slice(i, d));
      // 看到 "--"：第三个字符必须存在且为 '>'；否则内容里出现了 "--"。
      if (d + 2 >= n) return this.needMore(d); // 等第三个字符：'>' 或 '-'
      if (data[d + 2] !== '>') {
        this.failAt(data, d, '注释内容中不允许出现 "--"');
      }
      const text = this.pieces.join('');
      this.pieces = [];
      // 严格遵循 XML：注释不能为空（<!---->），也不能以 '-' 开头或结尾。
      if (text.length === 0 || text.startsWith('-') || text.endsWith('-')) {
        this.failAt(data, d, '注释不能为空，也不能以 "-" 开头或结尾');
      }
      if (ILLEGAL_DATA.test(text)) this.failAt(data, d, '注释中含有非法 XML 字符');
      const backToDoctype = this.commentBackDoctype;
      this.commentBackDoctype = false;
      if (backToDoctype) {
        this.state = 'doctype';
      } else {
        this.state = 'text';
        if (this.phase === 'prolog') this.preludeContentSeen = true;
        this.events.comment(text);
      }
      return d + 3;
    }
  }

  // -------------------------------------------------------------------------
  // CDATA
  // -------------------------------------------------------------------------

  private scanCdata(data: string, start: number): number {
    let i = start;
    const n = data.length;
    for (;;) {
      const end = data.indexOf(']]>', i);
      if (end !== -1) {
        if (end > i) this.emitCdata(data.slice(i, end));
        if (this.cdataBufLen > 0) {
          this.events.cdata(this.cdataBuf.join(''));
          this.cdataBuf.length = 0;
          this.cdataBufLen = 0;
        }
        // CDATA 与后续文本属于不同运行：CDATA 之前为检查 "]]>" 挂起的
        // ']' 尾巴不能带进来，否则会与结束标签前的字符拼出假的 "]]>"。
        this.state = 'text';
        return end + 3;
      }
      // 没有完整结束符。末尾凡是可能成为 "]]>" 前缀的 ']'（0~2 个）都不发送，
      // 连同其前面的内容一起保留到下次重扫（保留部分上次从未发送，故不重复）。
      let cut = n;
      while (cut > i && data[cut - 1] === ']' && n - cut < 2) cut--;
      if (cut > i) this.emitCdata(data.slice(i, cut));
      return this.needMore(cut);
    }
  }

  private emitCdata(s: string): void {
    if (ILLEGAL_DATA.test(s)) {
      throw new XmlParseError(this.line, this.column, 'CDATA 中含有非法 XML 字符');
    }
    this.appendRun(s, true);
  }

  // -------------------------------------------------------------------------
  // 处理指令（文档头 <?xml ...?> 声明走同一套词法但不产生事件）
  // -------------------------------------------------------------------------

  private scanPiTarget(data: string, start: number): number {
    let i = start;
    const n = data.length;
    while (i < n) {
      const ch = data[i];
      const code = ch.charCodeAt(0);
      if (isS(code) || ch === '?') break;
      if (!isNameChar(code) || ch === ':') {
        this.failAt(data, i, `非法的处理指令目标字符 "${ch}"`);
      }
      this.piTarget += ch;
      i++;
    }
    if (i === n) return n; // 目标名已在 piTarget 中，无需重扫
    if (this.piTarget.length === 0) this.failAt(data, i, '处理指令缺少目标名');
    if (this.piTarget.toLowerCase() === 'xml' && this.piTarget !== 'xml') {
      this.failAt(data, i, `处理指令目标名 "${this.piTarget}" 是保留名称`);
    }
    if (
      this.piTarget === 'xml' &&
      (this.rootSeen || this.doctypeSeen || this.preludeContentSeen)
    ) {
      this.failAt(data, i, 'XML 声明只能位于文档最开头');
    }
    this.state = 'piBody';
    this.piBody = [];
    this.piHasContent = false;
    return i;
  }

  private scanPiBody(data: string, start: number): number {
    let i = start;
    const n = data.length;
    if (!this.piHasContent) {
      if (data[i] === '?') {
        if (i + 1 >= n) return this.needMore(i);
        if (data[i + 1] !== '>') this.failAt(data, i, '处理指令中含有非法的 "?"');
        return this.finishPi(data, i + 2);
      }
      if (!isS(data.charCodeAt(i))) {
        this.failAt(data, i, `处理指令目标 "${this.piTarget}" 后期望空白或 "?>"`);
      }
      this.piHasContent = true;
      i++;
    }
    for (;;) {
      const end = data.indexOf('?>', i);
      if (end === -1) {
        const safe = Math.max(i, n - 1);
        if (safe > i) this.piBody.push(data.slice(i, safe));
        return this.needMore(safe);
      }
      if (end > i) this.piBody.push(data.slice(i, end));
      return this.finishPi(data, end + 2);
    }
  }

  private finishPi(data: string, after: number): number {
    const target = this.piTarget;
    const bodyRaw = this.piBody.join('');
    this.piTarget = '';
    this.piBody = [];
    this.piHasContent = false;
    this.state = 'text';
    if (target === 'xml') {
      validateXmlDecl(bodyRaw, data, after);
    } else {
      // 去掉一段前导空白，尾部空白原样保留。
      const body = bodyRaw.replace(/^[ \t\n]+/, '');
      if (ILLEGAL_DATA.test(body)) this.failAt(data, after - 1, '处理指令中含有非法 XML 字符');
      this.events.processingInstruction(target, body);
      if (this.phase === 'prolog') this.preludeContentSeen = true;
    }
    return after;
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function qname(n: QName): string {
  return n.prefix ? `${n.prefix}:${n.local}` : n.local;
}

/** 计算 data[0..at) 中的行/列增量（data[0] 计为 1 行 1 列，代理对算一列）。 */
function delta(data: string, at: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at; i++) {
    const c = data.charCodeAt(i);
    if (c === 0x0a) {
      line++;
      lineStart = i + 1;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < at) {
      i++;
    }
  }
  return { line, column: at - lineStart + 1 };
}

const XML_DECL =
  /^[ \t\n]*version[ \t\n]*=[ \t\n]*("1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\n]+encoding[ \t\n]*=[ \t\n]*("[A-Za-z][-A-Za-z0-9._]*"|'[A-Za-z][-A-Za-z0-9._]*'))?(?:[ \t\n]+standalone[ \t\n]*=[ \t\n]*("(?:yes|no)"|'(?:yes|no)'))?[ \t\n]*$/;

function validateXmlDecl(body: string, data: string, after: number): void {
  const m = XML_DECL.exec(body);
  if (!m) {
    const d = delta(data, Math.max(0, after - 2));
    throw new XmlParseError(
      d.line,
      d.column,
      '非法的 XML 声明（要求 version，可选 encoding/standalone）',
    );
  }
  // 我们只接受 UTF-8 输入。
  if (m[2] && !/^["']?(?:UTF-8|utf-8)["']?$/.test(m[2])) {
    const d = delta(data, Math.max(0, after - 2));
    throw new XmlParseError(d.line, d.column, `不支持的 XML 编码 ${m[2]}，只支持 UTF-8`);
  }
}
