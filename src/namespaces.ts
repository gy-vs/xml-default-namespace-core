import { XMLNS_NS, XML_NS } from './chars.js';

/**
 * 解析后的限定名。prefix 是词法前缀（无前缀时为 ''），
 * uri 是命名空间 URI（无命名空间时为 ''），local 是去掉前缀的本地名。
 */
export interface QName {
  prefix: string;
  local: string;
  uri: string;
}

export interface RawAttribute {
  /** 原始词法名，可能含冒号 */
  name: string;
  /** 已完成实体解码与字符合法性校验的值 */
  value: string;
}

export interface ResolvedAttribute extends QName {
  value: string;
}

interface Frame {
  parent: Frame | null;
  /** 前缀 -> URI；undefined 表示该前缀在本帧被解绑（xmlns="" 的内部表示） */
  prefixes: Map<string, string | undefined>;
}

/**
 * 命名空间前缀解析的链式作用域栈。
 *
 * 规则（Namespaces in XML 1.0）：
 * - 无前缀元素继承默认命名空间；默认命名空间可被内层 xmlns="..." 覆盖，
 *   也可被 xmlns="" 清空；兄弟节点离开作用域后恢复外层绑定。
 * - 无前缀属性永远不属于任何命名空间。
 * - xml 前缀恒绑定 http://www.w3.org/XML/1998/namespace，
 *   允许显式声明成同一个 URI，绑到别的 URI 属于错误。
 * - xmlns 前缀恒绑定 http://www.w3.org/2000/xmlns/，
 *   不能声明、解绑或拿它当普通前缀使用。
 */
export class NamespaceContext {
  private frame: Frame = { parent: null, prefixes: new Map() };

  /** 进入一个新元素，应用其上的命名空间声明，返回解析后的元素名与属性。 */
  push(
    rawName: string,
    rawAttrs: RawAttribute[],
  ): { name: QName; attrs: ResolvedAttribute[] } {
    const frame: Frame = { parent: this.frame, prefixes: new Map() };
    this.frame = frame;

    // 第一遍：落命名空间声明并做保留前缀校验。
    for (const attr of rawAttrs) {
      const eq = attr.name.indexOf(':');
      if (eq === -1) {
        if (attr.name === 'xmlns') {
          if (attr.value === XMLNS_NS) {
            throw new Error(
              `默认命名空间不能声明为保留命名空间 ${XMLNS_NS}`,
            );
          }
          frame.prefixes.set('', attr.value || undefined);
        }
        continue;
      }
      const prefix = attr.name.slice(0, eq);
      const local = attr.name.slice(eq + 1);
      if (prefix === 'xmlns') {
        if (local === 'xml') {
          if (attr.value !== XML_NS) {
            throw new Error(
              `不能把 xml 前缀绑定到 "${attr.value}"，它只能绑定到 ${XML_NS}`,
            );
          }
        } else if (local === 'xmlns') {
          throw new Error('不能声明 xmlns 前缀，它是保留前缀');
        } else if (attr.value === XML_NS) {
          throw new Error(
            `前缀 "${local}" 不能绑定到保留命名空间 ${XML_NS}（只有 xml 前缀可以）`,
          );
        } else if (attr.value === XMLNS_NS) {
          throw new Error(
            `前缀 "${local}" 不能绑定到保留命名空间 ${XMLNS_NS}`,
          );
        } else if (attr.value === '') {
          throw new Error(
            `命名空间前缀 "${local}" 不能被解绑为 ""（只有默认命名空间允许）`,
          );
        }
        frame.prefixes.set(local, attr.value);
      }
    }

    const name = this.splitQName(rawName, 'element');

    // 第二遍：解析普通属性（跳过 xmlns 声明），并按 (URI, local) 去重。
    const attrs: ResolvedAttribute[] = [];
    const seen = new Set<string>();
    for (const attr of rawAttrs) {
      if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) {
        continue;
      }
      const qn = this.splitQName(attr.name, 'attribute');
      const key = `${qn.uri} ${qn.local}`;
      if (seen.has(key)) {
        throw new Error(
          `重复属性: URI "${qn.uri}" 下的本地名 "${qn.local}" 出现多次`,
        );
      }
      seen.add(key);
      attrs.push({ ...qn, value: attr.value });
    }

    return { name, attrs };
  }

  /**
   * 在当前作用域里解析一个名字而不入栈（用于结束标签：
   * 元素自身的命名空间声明对自己的结束标签仍然在作用域内）。
   */
  resolve(rawName: string): QName {
    return this.splitQName(rawName, 'element');
  }

  private splitQName(raw: string, kind: 'element' | 'attribute'): QName {
    const ci = raw.indexOf(':');
    if (ci === -1) {
      if (kind === 'attribute') {
        // 无前缀属性不属于任何命名空间。
        return { prefix: '', local: raw, uri: '' };
      }
      return { prefix: '', local: raw, uri: this.lookupPrefix('') };
    }
    const prefix = raw.slice(0, ci);
    const local = raw.slice(ci + 1);
    if (prefix === '' || local === '' || local.includes(':')) {
      throw new Error(`非法的限定名: "${raw}"`);
    }
    if (prefix === 'xmlns') {
      throw new Error('xmlns 是保留前缀，不能用于元素或属性名');
    }
    if (prefix === 'xml') {
      return { prefix, local, uri: XML_NS };
    }
    const uri = this.lookupPrefix(prefix);
    if (uri === '') {
      throw new Error(`使用了未声明的命名空间前缀 "${prefix}"`);
    }
    return { prefix, local, uri };
  }

  private lookupPrefix(prefix: string): string {
    if (prefix === 'xml') return XML_NS;
    if (prefix === 'xmlns') return XMLNS_NS;
    for (let f: Frame | null = this.frame; f !== null; f = f.parent) {
      if (f.prefixes.has(prefix)) {
        return f.prefixes.get(prefix) ?? '';
      }
    }
    return '';
  }

  /** 离开元素，恢复外层作用域。 */
  pop(): void {
    if (this.frame.parent === null) {
      throw new Error('内部错误: 命名空间栈下溢');
    }
    this.frame = this.frame.parent;
  }

  /** 回到文档起始状态。 */
  reset(): void {
    this.frame = { parent: null, prefixes: new Map() };
  }
}
