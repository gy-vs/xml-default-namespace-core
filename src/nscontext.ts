/**
 * Namespace binding scope.
 *
 * Each element gets a frame listing the declarations carried on its own
 * start tag; lookup walks the chain of parent frames. The root frame holds
 * the immutable built-in `xml` binding.
 */

export const XML_NS_URI = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS_URI = 'http://www.w3.org/2000/xmlns/';

interface Frame {
  readonly parent: Frame | null;
  /** Null means the frame declares nothing (the common case): no Map cost. */
  readonly decls: ReadonlyMap<string, string> | null;
}

export class NamespaceContext {
  #root: Frame;
  #top: Frame;

  constructor() {
    this.#root = {
      parent: null,
      decls: new Map<string, string>([['xml', XML_NS_URI]]),
    };
    this.#top = this.#root;
  }

  /** Push a scope that declares no namespaces; reuses no storage. */
  pushEmpty(): void {
    this.#top = {parent: this.#top, decls: null};
  }

  /**
   * Push a new scope. `declarations` is a list of [prefix, uri] pairs; the
   * pair ['', uri] denotes a default namespace declaration (uri '' = undeclare).
   */
  push(declarations: ReadonlyArray<readonly [string, string]>): void {
    let decls: Map<string, string> | null = null;
    if (declarations.length !== 0) {
      decls = new Map();
      for (const [prefix, uri] of declarations) decls.set(prefix, uri);
    }
    this.#top = {parent: this.#top, decls};
  }

  pop(): void {
    if (this.#top.parent !== null) this.#top = this.#top.parent;
  }

  /** Resolve a prefix. The empty prefix looks up the default namespace. */
  lookup(prefix: string): string | null {
    for (let f: Frame | null = this.#top; f !== null; f = f.parent) {
      const d = f.decls;
      if (d !== null) {
        const uri = d.get(prefix);
        if (uri !== undefined) return uri;
      }
    }
    return null;
  }

  reset(): void {
    this.#top = this.#root;
  }
}
